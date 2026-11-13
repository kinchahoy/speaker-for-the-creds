// `mise run init bottle-school`: checks the host, asks how bottle-school reaches speaker and the model, writes
// ~/.bottle-school/config.json, builds the guest image, registers with speaker and runs a smoke-test task. Every question has a flag.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type parseArgs, styleText } from "node:util";
import * as p from "@clack/prompts";
import { z } from "zod";
import { bottleHome, configPathFromEnv, loadConfig, microsandboxHome, validateConfig } from "./src/config.ts";
import { hostApproved, registerHost } from "./src/speaker.ts";

export const bottleFlags = {
  yes: { type: "boolean" },
  force: { type: "boolean" },
  "control-port": { type: "string" },
  "guest-port": { type: "string" },
  "speaker-url": { type: "string" },
  "model-endpoint": { type: "string" },
  model: { type: "string" },
  image: { type: "string" },
  "password-stdin": { type: "boolean" },
  "skip-build": { type: "boolean" },
  "skip-register": { type: "boolean" },
  "skip-smoke": { type: "boolean" },
} as const;
export type BottleFlags = ReturnType<typeof parseArgs<{ options: typeof bottleFlags }>>["values"];

const here = import.meta.dirname;
// Successes get their own check mark, so they cannot be mistaken for a question's diamond.
const ok = (message: string) => p.log.message(message, { symbol: styleText("green", "✓") });
const MIN_FREE_GIB = 20;
const WAIT_MS = 10 * 60_000;
const SMOKE_PROMPT = "write the word hello to /output/hello.txt, then finish";

const fail = (what: string, fix: string): never => {
  throw new Error(`${what}. Fix: ${fix}`);
};
const answered = <T,>(value: T | symbol): Exclude<T, symbol> => {
  if (p.isCancel(value)) {
    p.cancel("Cancelled. Nothing more was changed.");
    process.exit(1);
  }
  return value as Exclude<T, symbol>;
};
/** The flag if given, else the default under --yes, else the prompt. */
const ask = async <T, F extends T | undefined>(given: T | undefined, yes: boolean, fallback: F, prompt: () => Promise<NoInfer<T> | symbol>): Promise<T | F> =>
  given ?? (yes ? fallback : (answered(await prompt()) as T));
const isFree = (port: number, host: string) =>
  new Promise<boolean>((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, host, () => probe.close(() => done(true)));
  });
const command = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const stop = (message: string): never => {
  p.cancel(message);
  process.exit(1);
};
/** At a terminal, asks to update an existing install; under --yes it needs --force. Returns true when it asked. */
const confirmUpdate = async (what: string, fix: string, force: boolean, yes: boolean) => {
  if (force) return false;
  if (yes) fail(what, fix);
  const update = answered(await p.confirm({ message: `${what}. Update it? Your current settings become the defaults; state, output, and images are kept.`, initialValue: true }));
  return update || stop("Nothing was changed.");
};
/** Repeats the check until it passes: at a terminal it asks you to fix the problem and try again; under --yes it fails. */
const untilFixed = async (problem: () => Promise<string | undefined>, fix: string, yes: boolean) => {
  for (let found = await problem(); found !== undefined; found = await problem()) {
    if (yes) fail(found, fix);
    p.log.warn(`${found}. Fix: ${fix}`);
    if (!answered(await p.confirm({ message: "Fixed it? Check again", active: "Check again", inactive: "Quit", initialValue: true }))) stop("Nothing more was changed.");
  }
};
/** The parts of an existing config.json that become the defaults when updating it. */
type Previous = { configRoot?: string; controlPort?: number; guestPort?: number; guestImage?: string; speaker?: { url?: string }; localModel?: { upstream?: string; models?: { id: string }[] } };
const readPrevious = (path: string): Previous | undefined => {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Previous;
  } catch (error) {
    return fail(`${path} is not valid JSON (${(error as Error).message})`, "fix it, or delete it to start over");
  }
};

const checkHost = (needDocker: boolean) => {
  if (platform() === "darwin") {
    if (!command("sysctl", ["-n", "kern.hv_support"])) fail("hardware virtualization is not available", "use a Mac with Hypervisor.framework support");
  } else {
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    } catch {
      fail("/dev/kvm is missing or not accessible", "sudo usermod -aG kvm $USER, then log in again (WSL: wsl --shutdown)");
    }
  }
  if (!command("sh", ["-c", "command -v setsid"])) fail("setsid is missing", platform() === "darwin" ? "brew install util-linux" : "sudo apt install util-linux");
  if (needDocker && !command("docker", ["info"])) fail("the Docker daemon is not reachable", "install Docker and start it, or pass --skip-build if the guest image is already loaded");
};

/** The first existing directory at or above the path: where a new home would be created. */
const existingAncestor = (path: string): string => (existsSync(path) ? path : existingAncestor(dirname(path)));

async function pickPort(given: string | undefined, yes: boolean, label: string, purpose: string, flag: string, fallback: number, taken: number[]) {
  for (let value = given; ; value = undefined) {
    const raw = await ask(value, yes, String(fallback), () => p.text({ message: `${label} port: ${purpose} (Enter keeps ${fallback})`, placeholder: String(fallback), defaultValue: String(fallback) }));
    const port = Number(raw);
    const problem = !Number.isInteger(port) || port < 1 || port > 65535 ? "is not a port number" : taken.includes(port) || !(await isFree(port, "127.0.0.1")) ? "is already in use" : undefined;
    if (!problem) return port;
    if (value !== undefined || yes) fail(`${label} port ${raw} ${problem}`, `choose another with --${flag}`);
    p.log.warn(`Port ${raw} ${problem === "is already in use" ? "is in use" : problem}; choose another.`);
  }
}

const loopback = (url: string) => {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "0.0.0.0" || host === "[::1]" || host.startsWith("127.");
};

const speakerUrlProblem = (value: string) => {
  try {
    new URL(value);
  } catch {
    return "Enter a full URL such as http://192.168.1.10:3000";
  }
  return loopback(value) ? "A VM cannot reach a loopback address; use this machine's LAN address, for example http://192.168.1.10:3000" : undefined;
};

const Models = z.object({ data: z.array(z.object({ id: z.string() })) });

async function pickModel(endpoint: string, wanted: string | undefined, yes: boolean, previous: string | undefined) {
  const url = `http://${endpoint}/v1/models`;
  const listed = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    .then(async (response) => Models.parse(await response.json()).data.map((entry) => entry.id))
    .catch(() => fail(`the model server did not answer ${url} with a model list`, "start it, or correct the host:port (an OpenAI-compatible server)"));
  if (listed.length === 0) fail(`${url} lists no models`, "load a model on that server");
  if (wanted !== undefined) return listed.includes(wanted) ? wanted : fail(`${endpoint} does not serve model ${wanted}`, `use one of: ${listed.join(", ")}`);
  if (listed.length === 1) return listed[0]!;
  if (yes && previous !== undefined && listed.includes(previous)) return previous;
  if (yes) fail(`${endpoint} serves several models (${listed.join(", ")})`, "pass --model <id>");
  return answered(await p.autocomplete({ message: `Model (${listed.length} available; type to filter, arrows move, Enter picks the highlighted one)`, maxItems: 8, initialValue: previous, options: listed.map((id) => ({ value: id, label: id })) }));
}

/** Runs start.sh detached with its output in a log file. */
const startDetached = (logFile: string, env: NodeJS.ProcessEnv) => {
  const out = openSync(logFile, "a", 0o600);
  const child = spawn("./start.sh", [], { cwd: here, env, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  closeSync(out);
  return child;
};

/** Polls until the check passes, showing the message; fails after ten minutes. */
async function waitFor(message: string, done: string, timeout: string, check: () => Promise<boolean>) {
  const spin = p.spinner();
  spin.start(message);
  for (const deadline = Date.now() + WAIT_MS; !(await check()); await sleep(2_000))
    if (Date.now() > deadline) {
      spin.stop(timeout);
      fail(timeout, "fix that, then run `mise run init bottle-school --force` again");
    }
  spin.stop(done);
}

const readStdin = async () => {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.replace(/\r?\n$/, "");
};

/** Signs in to speaker's /admin; returns the session cookie, or undefined when the password was wrong. One try, no retries: sign-in allows 5 failures per 15 minutes. */
async function signIn(speakerUrl: string, password: string) {
  const response = await fetch(`${speakerUrl}/admin/signin`, { method: "POST", headers: { origin: new URL(speakerUrl).origin }, body: new URLSearchParams({ password }), redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (response.status === 303) return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  if (response.status === 401) return undefined;
  return fail(`speaker answered the sign-in with HTTP ${response.status}${response.status === 429 ? " (too many failed attempts)" : ""}`, `wait a few minutes, or sign in at ${speakerUrl}/admin yourself`);
}

/** Approves the pending sandbox host through the form route the admin page uses, signed in as the owner. */
async function approveHost(speakerUrl: string, password: string, id: string) {
  const cookie = (await signIn(speakerUrl, password)) ?? fail("speaker rejected the owner password", `approve the sandbox host at ${speakerUrl}/admin#host-${id}`);
  const response = await fetch(`${speakerUrl}/admin/hosts/${id}/approve`, { method: "POST", headers: { origin: new URL(speakerUrl).origin, cookie }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (response.status !== 303) fail(`speaker answered the approval with HTTP ${response.status}`, `approve the sandbox host at ${speakerUrl}/admin#host-${id}`);
}

/** Unlocks a locked speaker with the owner password (given or typed); returns the password, or undefined when the owner chose to sign in themselves. */
async function unlockSpeaker(speakerUrl: string, given: string | undefined, yes: boolean) {
  let password = given;
  if (password !== undefined) {
    if (password === "" || (await signIn(speakerUrl, password)) === undefined) fail("speaker rejected the owner password", `pass the right one, or sign in at ${speakerUrl}/admin yourself`);
  } else if (yes) return undefined;
  else
    for (;;) {
      const typed = answered(await p.password({ message: `Speaker is locked. Enter the owner password to unlock it (or press Enter to sign in at ${speakerUrl}/admin yourself)` }));
      if (typed === "") return undefined;
      if ((await signIn(speakerUrl, typed)) !== undefined) {
        password = typed;
        break;
      }
      p.log.warn("Wrong password. Try again.");
    }
  ok("Speaker is unlocked.");
  return password;
}

export async function initBottleSchool(flags: BottleFlags, ownerPassword?: string) {
  const yes = flags.yes ?? false;
  p.intro("bottle-school setup");
  const home = bottleHome();
  p.log.message(
    [
      "bottle-school runs coding agents in disposable VMs. Agents never hold a secret or reach the network on their own:",
      "each access (a secret, a website, a folder) is granted per task by speaker-for-the-creds, which you approve.",
      `This setup checks this machine, connects to speaker and your model server, and builds the VM image. Everything goes in ${home}.`,
    ].join("\n"),
  );
  // microsandbox keeps unix sockets under the home, and socket paths are capped near 104 bytes.
  if (home.length > 60) fail(`${home} is too long a path for bottle-school's unix sockets`, "set BOTTLE_SCHOOL_HOME to a shorter folder");
  const configPath = configPathFromEnv();
  const previous = readPrevious(configPath);
  if (previous !== undefined) await confirmUpdate(`bottle-school is already set up (${configPath})`, "keep using it, or pass --force to replace its config", flags.force ?? false, yes);
  checkHost(!flags["skip-build"]);
  ok("KVM access, setsid, and Docker are available.");

  const [configRoot, stateRoot, outputRoot, documents] = ["config", "state", "output", "share/documents"].map((name) => join(home, name));
  for (const directory of [home, configRoot, stateRoot, outputRoot, documents]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The guest image and VM disks need room, and microsandbox refuses a folder with a group- or world-writable ancestor.
  const msbHome = microsandboxHome();
  const disk = statfsSync(existingAncestor(msbHome));
  const freeGiB = (disk.bavail * disk.bsize) / 1024 ** 3;
  if (freeGiB < MIN_FREE_GIB) fail(`${msbHome} has ${freeGiB.toFixed(1)} GiB free and the guest image and VMs need ${MIN_FREE_GIB}`, "free space there, or set MSB_HOME to a folder on a larger filesystem");
  for (let directory = msbHome; ; directory = dirname(directory)) {
    const mode = statSync(directory, { throwIfNoEntry: false })?.mode ?? 0;
    if (mode & 0o022 && !(mode & 0o1000)) fail(`microsandbox refuses ${directory}: it is group- or world-writable`, `chmod go-w ${directory}`);
    if (directory === dirname(directory)) break;
  }

  const running = previous?.controlPort;
  if (running !== undefined)
    await untilFixed(
      () => fetch(`http://127.0.0.1:${running}/api/state`, { signal: AbortSignal.timeout(2_000) }).then((r) => (r.ok ? `bottle-school is running on port ${running}` : undefined), () => undefined),
      "stop it (kill the start.sh process, or Ctrl-C where you ran mise run bottle)",
      yes,
    );
  const controlPort = await pickPort(flags["control-port"], yes, "Control", "bottle-school's own API", "control-port", previous?.controlPort ?? 7001, []);
  const guestPort = await pickPort(flags["guest-port"], yes, "Guest", "VMs reach bottle-school here", "guest-port", previous?.guestPort ?? 7002, [controlPort]);

  const oldUrl = previous?.speaker?.url;
  const speakerUrl = (await ask(flags["speaker-url"], yes, oldUrl, () => p.text({ message: `Speaker's URL as the VMs see it; bottle-school asks speaker before granting any access${oldUrl ? ` (Enter keeps ${oldUrl})` : ""}`, placeholder: oldUrl ?? "http://192.168.1.10:3000", defaultValue: oldUrl, validate: (v) => (v || !oldUrl ? speakerUrlProblem(v ?? "") : undefined) })))?.replace(/\/$/, "") ?? fail("--yes needs speaker's URL", "pass --speaker-url");
  const urlProblem = speakerUrlProblem(speakerUrl);
  if (urlProblem) fail(`speaker URL ${speakerUrl} is not usable`, urlProblem);
  const healthy = await fetch(`${speakerUrl}/_speaker/health`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok, () => false);
  if (!healthy) fail(`speaker did not answer at ${speakerUrl}`, "start speaker (mise run speaker, or mise run init speaker), or correct the URL");
  ok(`Speaker answers at ${speakerUrl}.`);

  const oldEndpoint = previous?.localModel?.upstream;
  const endpoint = (await ask(flags["model-endpoint"], yes, oldEndpoint, () => p.text({ message: `Model server the agents think with: host:port of an OpenAI-compatible server (${oldEndpoint ? `Enter keeps ${oldEndpoint}` : "for example 192.168.1.20:8080"})`, placeholder: oldEndpoint, defaultValue: oldEndpoint, validate: (v) => (v?.trim() || oldEndpoint ? undefined : "Enter the model server's host:port.") }))) ?? fail("--yes needs the model server", "pass --model-endpoint host:port");
  const model = await pickModel(endpoint, flags.model, yes, previous?.localModel?.models?.[0]?.id);

  const oldImage = previous?.guestImage ?? "bottle-school-guest";
  const image = await ask(flags.image, yes, oldImage, () => p.text({ message: `Guest image: the Linux system each agent's VM boots (Enter keeps ${oldImage})`, placeholder: oldImage, defaultValue: oldImage }));
  const config = {
    ...JSON.parse(readFileSync(join(here, "config.example.json"), "utf8")),
    bindHost: "127.0.0.1",
    controlPort,
    guestPort,
    guestImage: image,
    speaker: { url: speakerUrl },
    configRoot,
    stateRoot,
    outputRoot,
    shareRoots: { documents },
    hostedProviders: [],
  };
  config.localModel = { ...config.localModel, upstream: endpoint, models: [{ id: model, label: model }] };
  try {
    validateConfig(config);
  } catch (error) {
    fail(`these settings are not valid: ${(error as Error).message}`, "correct the answer, then run init again");
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  for (const file of ["templates.json", "catalog.json"]) copyFileSync(join(here, file), join(configRoot, file));
  ok(`Wrote ${configPath}. Config, state, and output are under ${home}.`);

  const env = { ...process.env, BOTTLE_SCHOOL_CONFIG: configPath };
  if (!flags["skip-build"]) {
    const build = yes || answered(await p.confirm({ message: `Build the guest image "${image}" now? It needs about 10 GiB under ${msbHome} and several minutes the first time.`, initialValue: true }));
    if (build) {
      const status = await new Promise<number | null>((done) => spawn("sh", ["guest/build.sh", image], { cwd: here, env, stdio: "inherit" }).once("exit", done));
      if (status !== 0) fail("the guest image build failed", `read the output above, then run: BOTTLE_SCHOOL_CONFIG=${configPath} mise run guest-build ${image}`);
      ok(`Guest image ${image} is built and loaded.`);
    } else p.log.info(`Build it later with: mise run guest-build ${image}`);
  }

  const loaded = loadConfig(configPath);
  if (!flags["skip-register"]) {
    p.log.message("Next, this machine registers with speaker as a sandbox host. You approve it once; after that speaker answers its access requests.");
    // After a restart speaker is locked until the owner signs in; registering needs it open.
    const isLocked = () => fetch(`${speakerUrl}/_speaker/catalog`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.status === 503);
    let password = ownerPassword ?? (flags["password-stdin"] ? await readStdin() : undefined);
    if (await isLocked()) password = await unlockSpeaker(speakerUrl, password, yes);
    await waitFor(`Speaker is locked: sign in at ${speakerUrl}/admin to unlock it`, "Speaker is unlocked.", "speaker stayed locked", async () =>
      fetch(`${speakerUrl}/_speaker/catalog`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.status !== 503),
    );
    const id = await registerHost(loaded, configPath, hostname());
    if (password !== undefined) {
      await approveHost(speakerUrl, password, id);
      ok("Approved this sandbox host.");
    } else {
      p.log.info(`Sign in at ${speakerUrl}/admin, then approve the sandbox host there (link: ${speakerUrl}/admin#host-${id})`);
      await waitFor("Waiting for you to approve the sandbox host", "Sandbox host approved.", "the sandbox host was not approved within ten minutes", () => hostApproved(loaded));
    }
  } else p.log.info("Register later with: mise run bottle-cli register");

  const imageLoaded = spawnSync(join(here, "node_modules/.bin/msb"), ["image", "inspect", image], { env: { ...env, MSB_HOME: msbHome }, stdio: "ignore" }).status === 0;
  if (!flags["skip-smoke"] && !imageLoaded) p.log.warn(`Skipping the smoke test: the guest image "${image}" is not loaded. Build it with: mise run guest-build ${image}`);
  const smoke = !flags["skip-smoke"] && !flags["skip-register"] && imageLoaded && (yes || answered(await p.confirm({ message: "Start bottle-school and run one small test task to check it all works?", initialValue: true })));
  if (smoke) {
    const logFile = join(home, "bottle-school.log");
    const server = startDetached(logFile, env);
    let exited: number | null | undefined;
    server.once("exit", (code) => (exited = code));
    const control = `http://127.0.0.1:${controlPort}`;
    await waitFor("Starting bottle-school", "bottle-school is running.", `bottle-school did not start; read ${logFile}`, () =>
      exited !== undefined ? fail(`bottle-school exited (code ${exited}) before it answered`, `read ${logFile}`) : fetch(`${control}/api/state`).then((r) => r.ok, () => false),
    );
    p.log.info(`bottle-school runs in the background (pid ${server.pid}). Stop it with: kill ${server.pid}`);
    const created = await fetch(`${control}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ template: "offline", name: "smoke-test", prompt: SMOKE_PROMPT }) });
    const { id, error } = (await created.json()) as { id?: string; error?: string };
    if (!id) fail(`the smoke-test task did not start: ${error ?? created.status}`, `read ${logFile}`);
    await waitFor(`Smoke-test task ${id} is running ("${SMOKE_PROMPT}")`, `Task ${id} archived.`, `task ${id} did not finish. See: mise run bottle-cli ls`, async () => {
      const { tasks } = (await (await fetch(`${control}/api/state`)).json()) as { tasks: { id: string; state: string }[] };
      const task = tasks.find((entry) => entry.id === id);
      if (task?.state === "failed" || task?.state === "failed-archive") fail(`the smoke-test task ${task.state}`, `read ${logFile} and the archive under ${outputRoot}`);
      return task === undefined;
    });
    const archive = readdirSync(outputRoot).find((name) => name.endsWith(`--${id}`)) ?? fail(`task ${id} left no archive`, `look in ${outputRoot}`);
    const result = join(outputRoot, archive, "artifacts", "hello.txt");
    if (!existsSync(result)) fail(`the task archived without /output/hello.txt`, `read the transcript in ${join(outputRoot, archive)}`);
    ok(`Smoke test passed: hello.txt contains "${readFileSync(result, "utf8").trim()}" (${result}).`);
  } else p.log.info("Start it with: mise run bottle");
  p.outro("bottle-school is set up. Launch work with: mise run bottle-cli run --template offline --prompt \"...\"");
}

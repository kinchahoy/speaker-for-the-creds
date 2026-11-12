// `mise run init bottle-school`: checks the host, asks where bottle-school lives and how it reaches speaker and the model,
// writes config.json, builds the guest image, registers with speaker and runs a smoke-test task. Every question has a flag.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import { z } from "zod";
import { configPathFromEnv, loadConfig, validateConfig } from "./src/config.ts";
import { hostApproved, registerHost } from "./src/speaker.ts";

export const bottleFlags = {
  yes: { type: "boolean" },
  force: { type: "boolean" },
  home: { type: "string" },
  "control-port": { type: "string" },
  "guest-port": { type: "string" },
  "speaker-url": { type: "string" },
  "model-endpoint": { type: "string" },
  model: { type: "string" },
  image: { type: "string" },
  "password-stdin": { type: "boolean" },
  config: { type: "string" },
  "skip-build": { type: "boolean" },
  "skip-register": { type: "boolean" },
  "skip-smoke": { type: "boolean" },
} as const;
export type BottleFlags = ReturnType<typeof parseArgs<{ options: typeof bottleFlags }>>["values"];

const here = import.meta.dirname;
const MIN_FREE_GIB = 20;
const WAIT_MS = 10 * 60_000;
// microsandbox puts a unix socket about 50 bytes below its home (<stateRoot>/microsandbox); the platform caps socket paths.
const SOCKET_ROOM = 50;
const SOCKET_LIMIT = platform() === "darwin" ? 104 : 108;
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

async function pickPort(given: string | undefined, yes: boolean, label: string, flag: string, fallback: number, taken: number[]) {
  for (let value = given; ; value = undefined) {
    const raw = await ask(value, yes, String(fallback), () => p.text({ message: `${label} port`, placeholder: String(fallback), defaultValue: String(fallback) }));
    const port = Number(raw);
    const problem = !Number.isInteger(port) || port < 1 || port > 65535 ? "is not a port number" : taken.includes(port) || !(await isFree(port, "127.0.0.1")) ? "is already in use" : undefined;
    if (!problem) return port;
    if (value !== undefined || yes) fail(`${label} port ${raw} ${problem}`, `choose another with --${flag}`);
    p.log.warn(`${raw} ${problem}; choose another.`);
  }
}

const loopback = (url: string) => {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "0.0.0.0" || host === "[::1]" || /^127\./.test(host);
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

async function pickModel(endpoint: string, wanted: string | undefined, yes: boolean) {
  const url = `http://${endpoint}/v1/models`;
  const listed = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    .then(async (response) => Models.parse(await response.json()).data.map((entry) => entry.id))
    .catch(() => fail(`the model server did not answer ${url} with a model list`, "start it, or correct the host:port (an OpenAI-compatible server)"));
  if (listed.length === 0) fail(`${url} lists no models`, "load a model on that server");
  if (wanted !== undefined) return listed.includes(wanted) ? wanted : fail(`${endpoint} does not serve model ${wanted}`, `use one of: ${listed.join(", ")}`);
  if (listed.length === 1) return listed[0]!;
  if (yes) fail(`${endpoint} serves several models (${listed.join(", ")})`, "pass --model <id>");
  return answered(await p.autocomplete({ message: "Model (type to filter)", maxItems: 8, options: listed.map((id) => ({ value: id, label: id })) }));
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

/** Signs in to speaker's /admin; true when it accepted the password, false when it was wrong. */
async function signIn(speakerUrl: string, password: string) {
  const response = await fetch(`${speakerUrl}/admin/signin`, { method: "POST", headers: { origin: new URL(speakerUrl).origin }, body: new URLSearchParams({ password }), redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (response.status === 303) return true;
  if (response.status === 401) return false;
  return fail(`speaker answered the sign-in with HTTP ${response.status}`, `sign in at ${speakerUrl}/admin yourself`);
}

/** Unlocks a locked speaker with the owner password (given, piped in, or typed); Enter at the prompt leaves it to the owner. */
async function unlockSpeaker(speakerUrl: string, flags: BottleFlags, known: string | undefined) {
  const given = known ?? (flags["password-stdin"] ? await readStdin() : undefined);
  if (given !== undefined) {
    if (!(await signIn(speakerUrl, given))) fail("speaker rejected the owner password", `pass the right one, or sign in at ${speakerUrl}/admin yourself`);
  } else if (flags.yes) return;
  else
    for (;;) {
      const typed = answered(await p.password({ message: `Speaker is locked. Enter the owner password to unlock it (or press Enter to sign in at ${speakerUrl}/admin yourself)` }));
      if (typed === "") return;
      if (await signIn(speakerUrl, typed)) break;
      p.log.warn("Wrong password. Try again.");
    }
  p.log.success("Speaker is unlocked.");
}

export async function initBottleSchool(flags: BottleFlags, ownerPassword?: string) {
  const yes = flags.yes ?? false;
  p.intro("bottle-school setup");
  const configPath = resolve(flags.config ?? configPathFromEnv());
  if (existsSync(configPath) && !flags.force) fail(`${configPath} already exists`, "delete it, or pass --force to replace it");
  checkHost(!flags["skip-build"]);
  p.log.success("KVM access, setsid, and Docker are available.");

  const defaultHome = join(homedir(), ".local", "share", "bottle-school");
  const home = resolve((await ask(flags.home, yes, defaultHome, () => p.text({ message: "Where should bottle-school keep its config, state, and output?", placeholder: defaultHome, defaultValue: defaultHome }))).replace(/^~(?=\/|$)/, homedir()));
  const disk = statfsSync(existingAncestor(home));
  const freeGiB = (disk.bavail * disk.bsize) / 1024 ** 3;
  if (freeGiB < MIN_FREE_GIB) fail(`${home} has ${freeGiB.toFixed(1)} GiB free and bottle-school needs ${MIN_FREE_GIB}`, "choose a home on a larger filesystem with --home");
  const stateHome = join(home, "state", "microsandbox");
  if (Buffer.byteLength(stateHome) + SOCKET_ROOM >= SOCKET_LIMIT)
    fail(`${stateHome} is too long for microsandbox's unix sockets (${Buffer.byteLength(stateHome)} bytes, plus about ${SOCKET_ROOM} for the socket; the limit is ${SOCKET_LIMIT})`, "choose a shorter --home");
  // Everything private (700): microsandbox refuses a storage root with a group- or world-writable ancestor. Checked now so a
  // bad home fails before the other questions.
  const [configRoot, stateRoot, outputRoot, documents] = ["config", "state", "output", "share/documents"].map((name) => join(home, name));
  for (const directory of [home, configRoot, stateRoot, outputRoot, documents]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let directory = join(stateRoot, "microsandbox"); ; directory = dirname(directory)) {
    const mode = statSync(directory, { throwIfNoEntry: false })?.mode ?? 0;
    if (mode & 0o022 && !(mode & 0o1000)) fail(`microsandbox refuses ${directory}: it is group- or world-writable`, `chmod go-w ${directory}, or choose another --home`);
    if (directory === dirname(directory)) break;
  }

  const controlPort = await pickPort(flags["control-port"], yes, "Control", "control-port", 7001, []);
  const guestPort = await pickPort(flags["guest-port"], yes, "Guest", "guest-port", 7002, [controlPort]);

  const speakerUrl = (await ask(flags["speaker-url"], yes, undefined, () => p.text({ message: "Speaker's URL as the VMs see it", placeholder: "http://192.168.1.10:3000", validate: (v) => speakerUrlProblem(v ?? "") })))?.replace(/\/$/, "") ?? fail("--yes needs speaker's URL", "pass --speaker-url");
  const urlProblem = speakerUrlProblem(speakerUrl);
  if (urlProblem) fail(`speaker URL ${speakerUrl} is not usable`, urlProblem);
  const healthy = await fetch(`${speakerUrl}/_speaker/health`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok, () => false);
  if (!healthy) fail(`speaker did not answer at ${speakerUrl}`, "start speaker (mise run speaker, or mise run init speaker), or correct the URL");
  p.log.success(`Speaker answers at ${speakerUrl}.`);

  const endpoint = (await ask(flags["model-endpoint"], yes, undefined, () => p.text({ message: "Model server (host:port, OpenAI-compatible)", placeholder: "192.168.1.20:8080" }))) ?? fail("--yes needs the model server", "pass --model-endpoint host:port");
  const model = await pickModel(endpoint, flags.model, yes);

  const image = await ask(flags.image, yes, "bottle-school-guest", () => p.text({ message: "Guest image tag", placeholder: "bottle-school-guest", defaultValue: "bottle-school-guest" }));
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
  p.log.success(`Wrote ${configPath}. Config, state, and output are under ${home}.`);

  const env = { ...process.env, BOTTLE_SCHOOL_CONFIG: configPath };
  if (!flags["skip-build"]) {
    const build = yes || answered(await p.confirm({ message: `Build the guest image "${image}" now? It needs about 10 GiB under ${stateRoot} and several minutes the first time.`, initialValue: true }));
    if (build) {
      const status = await new Promise<number | null>((done) => spawn("sh", ["guest/build.sh", image], { cwd: here, env, stdio: "inherit" }).once("exit", done));
      if (status !== 0) fail("the guest image build failed", `read the output above, then run: BOTTLE_SCHOOL_CONFIG=${configPath} mise run guest-build ${image}`);
      p.log.success(`Guest image ${image} is built and loaded.`);
    } else p.log.info(`Build it later with: mise run guest-build ${image}`);
  }

  const loaded = loadConfig(configPath);
  if (!flags["skip-register"]) {
    // After a restart speaker is locked until the owner signs in; registering needs it open.
    const isLocked = () => fetch(`${speakerUrl}/_speaker/me`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.status === 503);
    if (await isLocked()) await unlockSpeaker(speakerUrl, flags, ownerPassword);
    await waitFor(`Speaker is locked: sign in at ${speakerUrl}/admin to unlock it`, "Speaker is unlocked.", "speaker stayed locked", async () =>
      fetch(`${speakerUrl}/_speaker/me`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.status !== 503),
    );
    const id = await registerHost(loaded, configPath, hostname());
    p.log.info(`Approve this sandbox host in speaker: ${speakerUrl}/admin#host-${id}`);
    await waitFor("Waiting for you to approve the sandbox host", "Sandbox host approved.", "the sandbox host was not approved within ten minutes", () => hostApproved(loaded));
  } else p.log.info("Register later with: mise run bottle-cli register");

  const smoke = !flags["skip-smoke"] && !flags["skip-register"] && (yes || answered(await p.confirm({ message: "Start bottle-school and run a smoke-test task?", initialValue: true })));
  if (smoke) {
    const logFile = join(home, "bottle-school.log");
    const server = startDetached(logFile, env);
    const control = `http://127.0.0.1:${controlPort}`;
    await waitFor("Starting bottle-school", "bottle-school is running.", `bottle-school did not start; read ${logFile}`, () => fetch(`${control}/api/state`).then((r) => r.ok, () => false));
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
    p.log.success(`Smoke test passed: hello.txt contains "${readFileSync(result, "utf8").trim()}" (${result}).`);
  } else p.log.info("Start it with: mise run bottle");
  p.outro("bottle-school is set up. Launch work with: mise run bottle-cli run --template offline --prompt \"...\"");
}

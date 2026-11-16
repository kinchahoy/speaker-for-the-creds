// `mise run init bottle`: checks the host, asks how bottle reaches speaker and the model, writes
// ~/.bottle/config.json, builds the guest image, registers with speaker and runs a smoke-test agent. Every question has a flag.
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type parseArgs } from "node:util";
import * as p from "@clack/prompts";
import { z } from "zod";
import { bottleHome, configPathFromEnv, loadConfig, localModelProblem, microsandboxHome, validateConfig } from "./src/config.ts";
import { answered, ask, fail, ok, pickPort, readStdin } from "../speaker/init.ts";
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
  "skip-link": { type: "boolean" },
} as const;
export type BottleFlags = ReturnType<typeof parseArgs<{ options: typeof bottleFlags }>>["values"];

const here = import.meta.dirname;
const MIN_FREE_GIB = 20;
const WAIT_MS = 10 * 60_000;
const SMOKE_PROMPT = "write the word hello to /output/hello.txt, then finish";

const command = (cmd: string, args: string[], cwd?: string) => spawnSync(cmd, args, { stdio: "ignore", cwd }).status === 0;
const stop = (message: string): never => {
  p.cancel(message);
  process.exit(1);
};
/** Links `bottle` into ~/.local/bin, so the Herdr mod, Herdr's + menu and the owner can type `bottle` anywhere. */
const linkCli = () => {
  const dir = join(homedir(), ".local", "bin");
  const link = join(dir, "bottle");
  const cli = join(here, "src", "cli.ts");
  const found = lstatSync(link, { throwIfNoEntry: false });
  if (!found) {
    mkdirSync(dir, { recursive: true });
    symlinkSync(cli, link);
    ok(`Linked ${link} -> ${cli}.`);
  } else if (found.isSymbolicLink() && readlinkSync(link) === cli) ok(`bottle is already linked at ${link}.`);
  else return p.log.warn(`${link} exists and is not this checkout's CLI; remove it, then run init again to link ${cli}`);
  // Outside this repository the link runs on mise's global node.
  if (!command("node", ["--version"], homedir()))
    p.log.warn("No global node outside this repository, so `bottle` will not start there. Fix: mise use -g node@latest");
  if (!(process.env.PATH ?? "").split(delimiter).includes(dir))
    p.log.warn(`${dir} is not on PATH. Add it in your shell profile: export PATH="$HOME/.local/bin:$PATH"`);
};
/** At a terminal, asks to update an existing install; under --yes it needs --force. Returns true when it asked. */
const confirmUpdate = async (what: string, fix: string, force: boolean, yes: boolean) => {
  if (force) return false;
  if (yes) fail(what, fix);
  const update = answered(
    await p.confirm({ message: `${what}. Update it? Your current settings become the defaults; state, output, and images are kept.`, initialValue: true }),
  );
  return update || stop("Nothing was changed.");
};
/** Repeats the check until it passes: at a terminal it asks you to fix the problem and try again; under --yes it fails. */
const untilFixed = async (problem: () => Promise<string | undefined>, fix: string, yes: boolean) => {
  for (let found = await problem(); found !== undefined; found = await problem()) {
    if (yes) fail(found, fix);
    p.log.warn(`${found}. Fix: ${fix}`);
    if (!answered(await p.confirm({ message: "Fixed it? Check again", active: "Check again", inactive: "Quit", initialValue: true })))
      stop("Nothing more was changed.");
  }
};
/** The parts of an existing config.json that become the defaults when updating it. */
type Previous = {
  configRoot?: string;
  controlPort?: number;
  guestPort?: number;
  guestImage?: string;
  speaker?: { url?: string };
  localModel?: { upstream?: string; models?: { id: string }[] };
  hostedProviders?: unknown[];
};
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
  if (!command("sh", ["-c", "command -v setsid"]))
    fail("setsid is missing", platform() === "darwin" ? "brew install util-linux" : "sudo apt install util-linux");
  if (needDocker && !command("docker", ["info"]))
    fail("the Docker daemon is not reachable", "install Docker and start it, or pass --skip-build if the guest image is already loaded");
};

/** The first existing directory at or above the path: where a new home would be created. */
const existingAncestor = (path: string): string => (existsSync(path) ? path : existingAncestor(dirname(path)));

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
  return answered(
    await p.autocomplete({
      message: `Model (${listed.length} available; type to filter, arrows move, Enter picks the highlighted one)`,
      maxItems: 8,
      initialValue: previous,
      options: listed.map((id) => ({ value: id, label: id })),
    }),
  );
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
      fail(timeout, "fix that, then run `mise run init bottle --force` again");
    }
  spin.stop(done);
}

/** Signs in to speaker's /admin; returns the session cookie, or undefined when the password was wrong. One try, no retries: sign-in allows 5 failures per 15 minutes. */
async function signIn(speakerUrl: string, password: string) {
  const response = await fetch(`${speakerUrl}/admin/signin`, {
    method: "POST",
    headers: { origin: new URL(speakerUrl).origin },
    body: new URLSearchParams({ password }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 303)
    return response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
  if (response.status === 401) return undefined;
  return fail(
    `speaker answered the sign-in with HTTP ${response.status}${response.status === 429 ? " (too many failed attempts)" : ""}`,
    `wait a few minutes, or sign in at ${speakerUrl}/admin yourself`,
  );
}

/** Approves the pending sandbox host through the form route the admin page uses, signed in as the owner. */
async function approveHost(speakerUrl: string, password: string, id: string) {
  const cookie =
    (await signIn(speakerUrl, password)) ?? fail("speaker rejected the owner password", `approve the sandbox host at ${speakerUrl}/admin#host-${id}`);
  const response = await fetch(`${speakerUrl}/admin/hosts/${id}/approve`, {
    method: "POST",
    headers: { origin: new URL(speakerUrl).origin, cookie },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 303) fail(`speaker answered the approval with HTTP ${response.status}`, `approve the sandbox host at ${speakerUrl}/admin#host-${id}`);
}

/** Unlocks a locked speaker with the owner password (given or typed); returns the password, or undefined when the owner chose to sign in themselves. */
async function unlockSpeaker(speakerUrl: string, given: string | undefined, yes: boolean) {
  let password = given;
  if (password !== undefined) {
    if (password === "" || (await signIn(speakerUrl, password)) === undefined)
      fail("speaker rejected the owner password", `pass the right one, or sign in at ${speakerUrl}/admin yourself`);
  } else if (yes) return undefined;
  else
    for (;;) {
      const typed = answered(
        await p.password({ message: `Speaker is locked. Enter the owner password to unlock it (or press Enter to sign in at ${speakerUrl}/admin yourself)` }),
      );
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

export async function initBottle(flags: BottleFlags, ownerPassword?: string) {
  const yes = flags.yes ?? false;
  p.intro("bottle setup");
  const home = bottleHome();
  p.log.message(
    [
      "bottle runs coding agents in disposable VMs. Agents never hold a secret or reach the network on their own:",
      "each access (a secret, a website, a folder) is granted per agent by speaker-for-the-creds, which you approve.",
      `This setup checks this machine, connects to speaker and your model server, and builds the VM image. Everything goes in ${home}.`,
    ].join("\n"),
  );
  // microsandbox keeps unix sockets under the home, and socket paths are capped near 104 bytes.
  if (home.length > 60) fail(`${home} is too long a path for bottle's unix sockets`, "set BOTTLE_HOME to a shorter folder");
  const configPath = configPathFromEnv();
  const previous = readPrevious(configPath);
  if (previous !== undefined)
    await confirmUpdate(`bottle is already set up (${configPath})`, "keep using it, or pass --force to replace its config", flags.force ?? false, yes);
  checkHost(!flags["skip-build"]);
  ok("KVM access, setsid, and Docker are available.");

  const [configRoot, stateRoot, outputRoot] = ["config", "state", "output"].map((name) => join(home, name));
  for (const directory of [home, configRoot, stateRoot, outputRoot]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The guest image and VM disks need room, and microsandbox refuses a folder with a group- or world-writable ancestor.
  const msbHome = microsandboxHome();
  const disk = statfsSync(existingAncestor(msbHome));
  const freeGiB = (disk.bavail * disk.bsize) / 1024 ** 3;
  if (freeGiB < MIN_FREE_GIB)
    fail(
      `${msbHome} has ${freeGiB.toFixed(1)} GiB free and the guest image and VMs need ${MIN_FREE_GIB}`,
      "free space there, or set MSB_HOME to a folder on a larger filesystem",
    );
  for (let directory = msbHome; ; directory = dirname(directory)) {
    const mode = statSync(directory, { throwIfNoEntry: false })?.mode ?? 0;
    if (mode & 0o022 && !(mode & 0o1000)) fail(`microsandbox refuses ${directory}: it is group- or world-writable`, `chmod go-w ${directory}`);
    if (directory === dirname(directory)) break;
  }

  const running = previous?.controlPort;
  if (running !== undefined)
    await untilFixed(
      () =>
        fetch(`http://127.0.0.1:${running}/api/state`, { signal: AbortSignal.timeout(2_000) }).then(
          (r) => (r.ok ? `bottle is running on port ${running}` : undefined),
          () => undefined,
        ),
      "stop it (mise run bottle down)",
      yes,
    );
  const controlPort = await pickPort(flags["control-port"], yes, "Control", "bottle's own API", "control-port", previous?.controlPort ?? 7001, [], "127.0.0.1");
  const guestPort = await pickPort(
    flags["guest-port"],
    yes,
    "Guest",
    "VMs reach bottle here",
    "guest-port",
    previous?.guestPort ?? 7002,
    [controlPort],
    "127.0.0.1",
  );

  const oldUrl = previous?.speaker?.url;
  const speakerUrl =
    (
      await ask(flags["speaker-url"], yes, oldUrl, () =>
        p.text({
          message: `Speaker's URL as the VMs see it; bottle asks speaker before granting any access${oldUrl ? ` (Enter keeps ${oldUrl})` : ""}`,
          placeholder: oldUrl ?? "http://192.168.1.10:3000",
          defaultValue: oldUrl,
          validate: (v) => (v || !oldUrl ? speakerUrlProblem(v ?? "") : undefined),
        }),
      )
    )?.replace(/\/$/, "") ?? fail("--yes needs speaker's URL", "pass --speaker-url");
  const urlProblem = speakerUrlProblem(speakerUrl);
  if (urlProblem) fail(`speaker URL ${speakerUrl} is not usable`, urlProblem);
  const healthy = await fetch(`${speakerUrl}/_speaker/health`, { signal: AbortSignal.timeout(5_000) }).then(
    (r) => r.ok,
    () => false,
  );
  if (!healthy) fail(`speaker did not answer at ${speakerUrl}`, "start speaker (mise run speaker, or mise run init speaker), or correct the URL");
  ok(`Speaker answers at ${speakerUrl}.`);

  // "none" declines a local model: the agents then think only with hosted models (OpenRouter, Claude, OpenAI), whose
  // keys the owner enters on their speaker services.
  const oldEndpoint = previous ? (previous.localModel?.upstream ?? "none") : undefined;
  const endpoint =
    (
      await ask(flags["model-endpoint"], yes, oldEndpoint, () =>
        p.text({
          message: `Local model server: host:port of an OpenAI-compatible server on this network, or none for hosted models only (${oldEndpoint ? `Enter keeps ${oldEndpoint}` : "for example 192.168.1.20:8080"})`,
          placeholder: oldEndpoint ?? "none",
          defaultValue: oldEndpoint,
          validate: (v) => {
            const value = v?.trim() || oldEndpoint;
            if (!value) return "Enter the model server's host:port, or none.";
            return value === "none" ? undefined : localModelProblem(value);
          },
        }),
      )
    )?.trim() ?? fail("--yes needs the model server", "pass --model-endpoint host:port, or --model-endpoint none");
  const endpointProblem = endpoint === "none" ? undefined : localModelProblem(endpoint);
  if (endpointProblem) fail(`the model server ${endpoint} ${endpointProblem}`, "pass --model-endpoint host:port, or none");
  const model = endpoint === "none" ? undefined : await pickModel(endpoint, flags.model, yes, previous?.localModel?.models?.[0]?.id);

  const oldImage = previous?.guestImage ?? "bottle-guest";
  const image = await ask(flags.image, yes, oldImage, () =>
    p.text({ message: `Guest image: the Linux system each agent's VM boots (Enter keeps ${oldImage})`, placeholder: oldImage, defaultValue: oldImage }),
  );
  const config = {
    ...JSON.parse(readFileSync(join(here, "config.example.json"), "utf8")),
    bindHost: "127.0.0.1",
    controlPort,
    guestPort,
    guestImage: image,
    // The ports are placeholders from config.example.json until `register` learns the real ones from speaker.
    speaker: { ...JSON.parse(readFileSync(join(here, "config.example.json"), "utf8")).speaker, url: speakerUrl },
    configRoot,
    stateRoot,
    outputRoot,
  };
  // The starter hosted providers (OpenRouter, Claude, OpenAI) work once their keys are on the speaker services; an
  // existing config keeps its own list.
  if (previous?.hostedProviders) config.hostedProviders = previous.hostedProviders;
  config.localModel = model
    ? { ...config.localModel, upstream: endpoint, models: [{ id: model, label: model }] }
    : { guestHost: config.localModel.guestHost, models: [] };
  try {
    validateConfig(config);
  } catch (error) {
    fail(`these settings are not valid: ${(error as Error).message}`, "correct the answer, then run init again");
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  for (const file of ["templates.json", "catalog.json"]) copyFileSync(join(here, file), join(configRoot, file));
  ok(`Wrote ${configPath}. Config, state, and output are under ${home}.`);

  if (
    !flags["skip-link"] &&
    (yes || answered(await p.confirm({ message: "Link `bottle` into ~/.local/bin so it runs from any folder (the Herdr mod needs it)?", initialValue: true })))
  )
    linkCli();

  const env = { ...process.env, BOTTLE_CONFIG: configPath };
  if (!flags["skip-build"]) {
    const build =
      yes ||
      answered(
        await p.confirm({
          message: `Build the guest image "${image}" now? It needs about 10 GiB under ${msbHome} and several minutes the first time.`,
          initialValue: true,
        }),
      );
    if (build) {
      const status = await new Promise<number | null>((done) =>
        spawn("sh", ["guest/build.sh", image], { cwd: here, env, stdio: "inherit" }).once("exit", done),
      );
      if (status !== 0) fail("the guest image build failed", `read the output above, then run: BOTTLE_CONFIG=${configPath} mise run bottle build ${image}`);
      ok(`Guest image ${image} is built and loaded.`);
    } else p.log.info(`Build it later with: mise run bottle build ${image}`);
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
      const link = `${speakerUrl}/admin#host-${id}`;
      p.log.info(`Sign in at ${speakerUrl}/admin, then approve the sandbox host there (link: ${link})`);
      if (yes)
        await waitFor("Waiting for you to approve the sandbox host", "Sandbox host approved.", "the sandbox host was not approved within ten minutes", () =>
          hostApproved(loaded),
        );
      else {
        // The owner says when it is done; a check that finds no approval asks again.
        for (;;) {
          if (!answered(await p.confirm({ message: "Approved it? Press Enter to check", active: "Check", inactive: "Quit", initialValue: true })))
            fail("the sandbox host is not approved", `approve it at ${link}, then run \`mise run init bottle\` again`);
          if (await hostApproved(loaded)) break;
          p.log.warn(`Not approved yet: ${link}`);
        }
        ok("Sandbox host approved.");
      }
    }
  } else p.log.info("Register later with: mise run bottle register");

  const imageLoaded =
    spawnSync(join(here, "node_modules/.bin/msb"), ["image", "inspect", image], { env: { ...env, MSB_HOME: msbHome }, stdio: "ignore" }).status === 0;
  if (!flags["skip-smoke"] && !imageLoaded)
    p.log.warn(`Skipping the smoke test: the guest image "${image}" is not loaded. Build it with: mise run bottle build ${image}`);
  if (!model && !flags["skip-smoke"])
    p.log.info(
      'Skipping the smoke test: hosted models need a key in speaker first. Enter one on its service in Setup, then run: bottle run -m openrouter/<model> "..."',
    );
  const smoke =
    !flags["skip-smoke"] &&
    model !== undefined &&
    !flags["skip-register"] &&
    imageLoaded &&
    (yes || answered(await p.confirm({ message: "Start bottle and run one small test agent to check it all works?", initialValue: true })));
  if (smoke) {
    const logFile = join(home, "bottle.log");
    const server = startDetached(logFile, { ...env, BOTTLE_AUTOSTART: "1" });
    let exited: number | null | undefined;
    server.once("exit", (code) => (exited = code));
    const control = `http://127.0.0.1:${controlPort}`;
    await waitFor("Starting bottle", "bottle is running.", `bottle did not start; read ${logFile}`, () =>
      exited !== undefined
        ? fail(`bottle exited (code ${exited}) before it answered`, `read ${logFile}`)
        : fetch(`${control}/api/state`).then(
            (r) => r.ok,
            () => false,
          ),
    );
    p.log.info(`bottle runs in the background (pid ${server.pid}) and stops 10 minutes after its last agent. Stop it now with: mise run bottle down`);
    const created = await fetch(`${control}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "sealed", model: `local/${model}`, name: "smoke-test", prompt: SMOKE_PROMPT, attended: false }),
    });
    const { id, error } = (await created.json()) as { id?: string; error?: string };
    if (!id) fail(`the smoke-test agent did not start: ${error ?? created.status}`, `read ${logFile}`);
    await waitFor(
      `Smoke-test agent ${id} is running ("${SMOKE_PROMPT}")`,
      `Agent ${id} archived.`,
      `agent ${id} did not finish. See: mise run bottle ls`,
      async () => {
        const { agents } = (await (await fetch(`${control}/api/state`)).json()) as { agents: { id: string; state: string }[] };
        const agent = agents.find((entry) => entry.id === id);
        if (agent?.state === "failed" || agent?.state === "failed-archive")
          fail(`the smoke-test agent ${agent.state}`, `read ${logFile} and the archive under ${outputRoot}`);
        return agent === undefined;
      },
    );
    const archive = readdirSync(outputRoot).find((name) => name.endsWith(`--${id}`)) ?? fail(`agent ${id} left no archive`, `look in ${outputRoot}`);
    const result = join(outputRoot, archive, "artifacts", "hello.txt");
    if (!existsSync(result)) fail(`the agent archived without /output/hello.txt`, `read the transcript in ${join(outputRoot, archive)}`);
    ok(`Smoke test passed: hello.txt contains "${readFileSync(result, "utf8").trim()}" (${result}).`);
  } else p.log.info("bottle starts on demand with mise run bottle run (or run mise run bottle serve in the foreground)");
  p.outro(
    `bottle is set up. Launch work with (bottle starts on demand, and stops 10 minutes after its last agent; stop it now with \`mise run bottle down\`): bottle run${model ? "" : " -m openrouter/<model>"} "<prompt>" (add -d to leave it running in the background)`,
  );
}

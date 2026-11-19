import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { BlockList, isIPv4 } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { Template } from "./grants.ts";

const port = z.number().int().min(1).max(65_535);
const model = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  // Tokens the model accepts, for Pi's context meter and compaction; Pi assumes 128k for a model it does not know.
  contextWindow: z.number().int().positive().optional(),
  // A short name for -m and templates, unique across all models.
  alias: z
    .string()
    .regex(/^[a-z0-9-]+$/, "a model alias uses lowercase letters, digits, and dashes")
    .optional(),
  // OpenRouter only: its `provider` routing preferences, sent with every call (for example { "only": ["deepinfra/fp8"] }
  // pins the model to one upstream endpoint).
  openRouterRouting: z.record(z.string(), z.unknown()).optional(),
});

const HostedProviderSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "a provider id uses lowercase letters, digits, and dashes"),
  // The speaker service that holds the provider's key; the model door sends its calls to $SPEAKER_URL/<service>/.
  service: z.string().regex(/^[a-zA-Z0-9_-]+$/, "a service id uses letters, digits, dashes, and underscores"),
  models: z.array(model).min(1),
  // How Pi talks to it: OpenAI's chat completions (OpenRouter, OpenAI) or Anthropic's messages API (Claude).
  api: z.enum(["openai-completions", "anthropic-messages"]).default("openai-completions"),
});

const ConfigFile = z
  .object({
    bindHost: z.string(),
    controlPort: port,
    guestPort: port,
    maxAgents: z.number().int().min(1).max(3),
    guestImage: z.string().min(1),
    // proxyPort is speaker's PROXY_PORT: where requests to a granted secret's hosts go so speaker can insert the secret.
    // sshPort is speaker's SSH_PORT: where the guest reaches the jump server for `folder:` grants.
    speaker: z.object({ url: z.url(), proxyPort: port, sshPort: port }),
    stateRoot: z.string(),
    outputRoot: z.string(),
    // The guest's model endpoint (guestHost) always exists for hosted providers; the local model server behind it is
    // optional: no upstream means hosted models only.
    localModel: z.object({
      guestHost: z.hostname().refine((value) => value === value.toLowerCase(), "a guest model host must be lowercase"),
      upstream: z.string().min(1).optional(),
      models: z.array(model).default([]),
      // For a model server that sleeps when idle: a shell command that wakes it (for example a curl to a Home Assistant
      // webhook), and how long to wait for it to answer afterwards.
      wake: z.object({ command: z.string().min(1), waitSeconds: z.number().positive().default(180) }).optional(),
    }),
    hostedProviders: z.array(HostedProviderSchema),
    // What `bottle run -t <id>` launches: VM limits, the items asked for at launch, and the folders mounted.
    templates: z.array(Template).min(1),
    // A detached agent (run -d, or Ctrl-\ during run) gets a tab in the Herdr app's "bottle" space when `hc` is on PATH; false turns that off.
    herdr: z.boolean().optional(),
    // A bottle that `run` started stops itself once no agent has been open for this long; `serve` never does.
    idleStopMinutes: z.number().positive().default(10),
  })
  .strict()
  .superRefine((config, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    // Loopback, RFC1918, and the Tailscale CGNAT range are the only addresses this service binds.
    if (!isIPv4(config.bindHost) || !(lan.check(config.bindHost) || tailscale.check(config.bindHost)))
      fail(`bindHost must be one exact loopback, RFC1918, or Tailscale IPv4 address; config.json has "${config.bindHost}"`);
    else if (!Object.values(networkInterfaces()).some((entries) => entries?.some((entry) => entry.address === config.bindHost)))
      fail(`bindHost is not configured on this host: ${config.bindHost}`);
    if (config.controlPort === config.guestPort) fail("control and guest ports must be distinct");
    if (new Set(config.hostedProviders.map((provider) => provider.id)).size !== config.hostedProviders.length) fail("hosted provider ids must be unique");
    for (const provider of config.hostedProviders)
      if (new Set(provider.models.map((entry) => entry.id)).size !== provider.models.length) fail(`hosted provider ${provider.id} repeats a model id`);
    const upstream = config.localModel.upstream;
    const problem = upstream === undefined ? undefined : localModelProblem(upstream);
    if (problem) fail(`localModel.upstream ${problem}`);
    if ((upstream === undefined) !== (config.localModel.models.length === 0))
      fail("localModel needs both an upstream and its models, or neither (hosted models only)");
    if (!config.localModel.models.length && !config.hostedProviders.length) fail("configure a local model or a hosted provider");
    if (new Set(config.localModel.models.map((entry) => entry.id)).size !== config.localModel.models.length) fail("localModel repeats a model id");
    const aliases = [...config.localModel.models, ...config.hostedProviders.flatMap((provider) => provider.models)].flatMap((entry) => entry.alias ?? []);
    if (new Set(aliases).size !== aliases.length) fail("model aliases must be unique");
    if (new Set(config.templates.map(({ id }) => id)).size !== config.templates.length) fail("templates repeat an id");
  });

export type Config = z.infer<typeof ConfigFile>;

const lan = new BlockList();
for (const [network, prefix] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const)
  lan.addSubnet(network, prefix, "ipv4");
const tailscale = new BlockList();
tailscale.addSubnet("100.64.0.0", 10, "ipv4");

const assertDirectory = (label: string, path: string) => {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${label} must name an existing directory: ${path}`);
};

/** Why a local model server address is not usable, or undefined when it is: one loopback, RFC1918, or Tailscale IPv4 host:port. */
export const localModelProblem = (upstream: string) => {
  const [host, port] = upstream.split(":");
  return /^[^:]+:\d{1,5}$/.test(upstream) &&
    +port! >= 1 &&
    +port! <= 65_535 &&
    (host === "localhost" || (isIPv4(host!) && (lan.check(host!) || tailscale.check(host!))))
    ? undefined
    : "must be one loopback, RFC1918, or Tailscale IPv4 host:port endpoint (no http://, no path)";
};

/** Whether the local model server answers its model list within 2 s; it is the owner's own machine and not always up. */
export const localModelUp = (upstream: string) =>
  fetch(`http://${upstream}/v1/models`, { signal: AbortSignal.timeout(2_000) }).then(
    (response) => response.ok,
    () => false,
  );

let waking: Promise<boolean> | undefined;
/**
 * Whether the local model server answers, after waking it with `localModel.wake` when it does not. Calls that arrive
 * during a wake share it, so the command runs once.
 */
export const localModelReady = ({ localModel: { upstream, wake } }: Config, poll = 3_000): Promise<boolean> =>
  (waking ??= (async () => {
    if (await localModelUp(upstream!)) return true;
    if (!wake) return false;
    console.log(`local model server ${upstream} is not answering; waking it`);
    await promisify(execFile)("sh", ["-c", wake.command], { timeout: 30_000 }).catch((error: Error) =>
      console.error(`localModel.wake failed: ${error.message}`),
    );
    for (const deadline = Date.now() + wake.waitSeconds * 1_000; Date.now() < deadline; await sleep(poll)) if (await localModelUp(upstream!)) return true;
    return false;
  })().finally(() => (waking = undefined)));

export const validateConfig = (data: unknown): Config => {
  const config = ConfigFile.parse(data);
  assertDirectory("stateRoot", config.stateRoot);
  assertDirectory("outputRoot", config.outputRoot);
  return config;
};

/** Parse the owner-owned file before the service ever opens a network listener. */
export const loadConfig = (path: string): Config => validateConfig(JSON.parse(readFileSync(path, "utf8")));

/** Everything bottle keeps lives in one folder: BOTTLE_HOME, else ~/.bottle. */
export const bottleHome = (env: NodeJS.ProcessEnv = process.env) => env.BOTTLE_HOME || join(homedir(), ".bottle");

/** The config file path: BOTTLE_CONFIG, else <home>/config.json. */
export const configPathFromEnv = (env: NodeJS.ProcessEnv = process.env) => env.BOTTLE_CONFIG || join(bottleHome(env), "config.json");

/** microsandbox's own folder (images, VM disks, its unix sockets): MSB_HOME, else <home>/microsandbox. */
export const microsandboxHome = (env: NodeJS.ProcessEnv = process.env) => env.MSB_HOME || join(bottleHome(env), "microsandbox");

export const controlOrigin = (config: Config) => `http://${config.bindHost}:${config.controlPort}`;

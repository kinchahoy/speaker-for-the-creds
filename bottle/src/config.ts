import { readFileSync, statSync } from "node:fs";
import { BlockList, isIPv4 } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const port = z.number().int().min(1).max(65_535);
const model = z.object({ id: z.string().min(1), label: z.string().min(1) });

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
    maxTasks: z.number().int().min(1).max(3),
    guestImage: z.string().min(1),
    // proxyPort is speaker's PROXY_PORT: where requests to a granted secret's hosts go so speaker can insert the secret.
    // sshPort is speaker's SSH_PORT: where the guest reaches the jump server for `folder:` grants.
    speaker: z.object({ url: z.url(), proxyPort: port, sshPort: port }),
    configRoot: z.string(),
    stateRoot: z.string(),
    outputRoot: z.string(),
    // The guest's model endpoint (guestHost) always exists for hosted providers; the local model server behind it is
    // optional: no upstream means hosted models only.
    localModel: z.object({
      guestHost: z.hostname().refine((value) => value === value.toLowerCase(), "a guest model host must be lowercase"),
      upstream: z.string().min(1).optional(),
      models: z.array(model).default([]),
    }),
    hostedProviders: z.array(HostedProviderSchema),
    // Each task opens as a tab in the Herdr app (a "bottle" space) when `hc` is on PATH; false turns that off.
    herdr: z.boolean().optional(),
    // A bottle that `run` started stops itself once no task has been open for this long; `serve` never does.
    idleStopMinutes: z.number().positive().default(10),
  })
  .strict();

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

export const validateConfig = (data: unknown): Config => {
  const config = ConfigFile.parse(data);
  // Loopback, RFC1918, and the Tailscale CGNAT range are the only addresses this service binds.
  if (!isIPv4(config.bindHost) || !(lan.check(config.bindHost) || tailscale.check(config.bindHost)))
    throw new Error(`bindHost must be one exact loopback, RFC1918, or Tailscale IPv4 address; config.json has "${config.bindHost}"`);
  if (!Object.values(networkInterfaces()).some((entries) => entries?.some((entry) => entry.address === config.bindHost)))
    throw new Error(`bindHost is not configured on this host: ${config.bindHost}`);
  if (config.controlPort === config.guestPort) throw new Error("control and guest ports must be distinct");
  if (new Set(config.hostedProviders.map((provider) => provider.id)).size !== config.hostedProviders.length)
    throw new Error("hosted provider ids must be unique");
  for (const provider of config.hostedProviders)
    if (new Set(provider.models.map((entry) => entry.id)).size !== provider.models.length) throw new Error(`hosted provider ${provider.id} repeats a model id`);
  const upstream = config.localModel.upstream;
  if (upstream !== undefined) {
    const problem = localModelProblem(upstream);
    if (problem) throw new Error(`localModel.upstream ${problem}`);
  }
  if ((upstream === undefined) !== (config.localModel.models.length === 0))
    throw new Error("localModel needs both an upstream and its models, or neither (hosted models only)");
  if (!config.localModel.models.length && !config.hostedProviders.length) throw new Error("configure a local model or a hosted provider");
  if (new Set(config.localModel.models.map((entry) => entry.id)).size !== config.localModel.models.length) throw new Error("localModel repeats a model id");
  assertDirectory("configRoot", config.configRoot);
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

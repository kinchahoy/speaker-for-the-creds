import { existsSync, readFileSync, statSync } from "node:fs";
import { BlockList, isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { isAbsolute } from "node:path";
import { z } from "zod";

const port = z.number().int().min(1).max(65_535);
const model = z.object({ id: z.string().min(1), label: z.string().min(1) });

const HostedProviderSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "a provider id uses lowercase letters, digits, and dashes"),
  baseUrl: z
    .url()
    .refine((value) => new URL(value).protocol === "https:", "a hosted provider uses https"),
  host: z
    .hostname()
    .refine((value) => value === value.toLowerCase(), "a hosted provider host must be lowercase"),
  credential: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9_]*$/,
      "a credential name uses uppercase letters, digits, and underscores",
    ),
  models: z.array(model).min(1),
});

const ConfigFile = z
  .object({
    // Supported sandbox backends; src/backends/index.ts holds the implementations.
    backend: z.enum(["gondolin"], { error: 'backend must be one of the supported backends: gondolin' }).default("gondolin"),
    bindHost: z.string(),
    controlPort: port,
    guestPort: port,
    maxTasks: z.number().int().min(1).max(3),
    guestImage: z.string().min(1),
    // proxyPort is speaker's PROXY_PORT: where requests to a granted secret's hosts go so speaker can insert the secret.
    speaker: z.object({ url: z.url(), proxyPort: port.optional() }),
    configRoot: z.string(),
    stateRoot: z.string(),
    outputRoot: z.string(),
    shareRoots: z.record(
      z.string().regex(/^[a-z0-9-]+$/, "a share root uses lowercase letters, digits, and dashes"),
      z.string(),
    ),
    localModel: z.object({
      guestHost: z
        .hostname()
        .refine((value) => value === value.toLowerCase(), "a guest model host must be lowercase"),
      upstream: z.string().min(1),
      models: z.array(model).min(1),
    }),
    hostedProviders: z.array(HostedProviderSchema),
  })
  .strict();

export type HostedProvider = z.infer<typeof HostedProviderSchema>;
export type Config = z.infer<typeof ConfigFile>;

const lan = new BlockList();
for (const [network, prefix] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const)
  lan.addSubnet(network, prefix, "ipv4");
const tailscale = new BlockList();
tailscale.addSubnet("100.64.0.0", 10, "ipv4");

const assertDirectory = (label: string, path: string) => {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`${label} must name an existing directory: ${path}`);
};

export const validateConfig = (data: unknown): Config => {
  const config = ConfigFile.parse(data);
  // Loopback, RFC1918, and the Tailscale CGNAT range are the only addresses this service binds.
  if (!isIPv4(config.bindHost) || !(lan.check(config.bindHost) || tailscale.check(config.bindHost)))
    throw new Error(
      `bindHost must be one exact loopback, RFC1918, or Tailscale IPv4 address; config.json has "${config.bindHost}"`,
    );
  if (!Object.values(networkInterfaces()).some((entries) => entries?.some((entry) => entry.address === config.bindHost)))
    throw new Error(`bindHost is not configured on this host: ${config.bindHost}`);
  if (config.controlPort === config.guestPort)
    throw new Error("control and guest ports must be distinct");
  if (
    new Set(config.hostedProviders.map((provider) => provider.id)).size !==
    config.hostedProviders.length
  )
    throw new Error("hosted provider ids must be unique");
  for (const provider of config.hostedProviders) {
    if (new URL(provider.baseUrl).hostname !== provider.host)
      throw new Error(`hosted provider ${provider.id} baseUrl must use ${provider.host}`);
    if (new Set(provider.models.map((entry) => entry.id)).size !== provider.models.length)
      throw new Error(`hosted provider ${provider.id} repeats a model id`);
  }
  const [upstreamHost, upstreamPort] = config.localModel.upstream.split(":");
  if (
    !/^[^:]+:\d{1,5}$/.test(config.localModel.upstream) ||
    +upstreamPort < 1 ||
    +upstreamPort > 65_535 ||
    !(upstreamHost === "localhost" || (isIPv4(upstreamHost) && (lan.check(upstreamHost) || tailscale.check(upstreamHost))))
  )
    throw new Error("localModel.upstream must be one loopback, RFC1918, or Tailscale IPv4 host:port endpoint");
  if (
    new Set(config.localModel.models.map((entry) => entry.id)).size !==
    config.localModel.models.length
  )
    throw new Error("localModel repeats a model id");
  assertDirectory("configRoot", config.configRoot);
  assertDirectory("stateRoot", config.stateRoot);
  assertDirectory("outputRoot", config.outputRoot);
  for (const [id, root] of Object.entries(config.shareRoots))
    assertDirectory(`shareRoots.${id}`, root);
  return config;
};

/** Parse the owner-owned file before the service ever opens a network listener. */
export const loadConfig = (path: string): Config => validateConfig(JSON.parse(readFileSync(path, "utf8")));

export const controlOrigin = (config: Config) => `http://${config.bindHost}:${config.controlPort}`;

/**
 * Secrets live in speaker; bottle-school never holds one. A leftover secrets.env or BROKER_SECRET_* variable would be a
 * real secret on this host that nothing uses, so startup stops until it is moved into speaker's Setup and removed.
 */
export const assertNoHostSecrets = (config: Pick<Config, "configRoot">, env: NodeJS.ProcessEnv = process.env) => {
  const file = `${config.configRoot}/secrets.env`;
  const variables = Object.keys(env).filter((name) => name.startsWith("BROKER_SECRET_"));
  if (existsSync(file) || variables.length)
    throw new Error(
      `bottle-school no longer holds secrets: add ${existsSync(file) ? file : variables.join(", ")} to speaker's Setup as a secret (with its allowed hosts), then delete it here`,
    );
};

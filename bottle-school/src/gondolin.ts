import {
  ERRNO,
  RealFSProvider,
  ReadonlyProvider,
  VM,
  VirtualProviderClass,
  createHttpHooks,
  createVirtualDirStats,
  formatVirtualEntries,
  normalizeVfsPath,
  type VirtualProvider,
} from "@earendil-works/gondolin";
import { randomUUID } from "node:crypto";
import { BlockList } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Config } from "./config.ts";
import type { Dispatcher } from "undici";
import { hostMatches, ipv4Destination, speakerRequestAllowed, unexpired, type Timed } from "./leases.ts";

export type HttpResponseRecord = {
  at: string;
  method: string;
  destination: string;
  requestHeaders: Record<string, string>;
  status: number;
  responseHeaders: Record<string, string>;
  durationMs: number;
  bytes?: number;
  complete: boolean;
  error?: string;
  requestCapture: "complete" | "truncated" | "metadata_only" | "empty";
  responseCapture: "complete" | "truncated" | "metadata_only" | "empty";
  requestBody?: CapturedBody;
  responseBody?: CapturedBody;
};

export type CapturedBody = {
  path: string;
  contentType?: string;
  capturedBytes: number;
  totalBytes: number;
  limitBytes: number;
  truncated: boolean;
};

/** The live lease view every Gondolin hook reads. Each speaker snapshot replaces these entries; every use checks expiry. */
export type Live = {
  hosts: (Timed & { host: string })[];
  /** Granted `secret:` items and the hosts speaker bound them to. Requests to these hosts go through speaker's proxy. */
  secretHosts: (Timed & { name: string; hosts: string[] })[];
  shares: Map<string, Timed & { provider: VirtualProvider }>;
  events: { at: string; text: string }[];
  httpResponses: HttpResponseRecord[];
  httpResponsesOmitted: number;
  httpBodyBytes: number;
  /** Spend cap: model requests allowed so far, the owner's limit, and whether the refusal was recorded. */
  modelRequests: number;
  maxModelRequests?: number;
  modelCapNoted: boolean;
};

const capturedHeaders = new Set([
  "accept",
  "content-length",
  "content-type",
  "date",
  "openai-beta",
  "openai-processing-ms",
  "anthropic-version",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-input-tokens-remaining",
  "anthropic-ratelimit-output-tokens-remaining",
  "retry-after",
  "server",
  "traceparent",
  "tracestate",
  "user-agent",
  "x-api-version",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "x-request-id",
  "request-id",
]);
const safeHeaders = (headers: Headers) =>
  Object.fromEntries([...headers].filter(([name]) => capturedHeaders.has(name)));

export const note = (live: Pick<Live, "events">, text: string) => {
  live.events.push({ at: new Date().toISOString(), text });
  if (live.events.length > 2_000) live.events.splice(0, live.events.length - 2_000);
};

/** Gondolin's request hook can only allow or refuse, so a refused model request gets Gondolin's fixed 403. */
const countModelRequest = (live: Live) => {
  if (live.maxModelRequests === undefined || live.modelRequests < live.maxModelRequests) {
    live.modelRequests += 1;
    return true;
  }
  if (!live.modelCapNoted)
    note(live, `model request limit ${live.maxModelRequests} reached; the owner can raise it`);
  live.modelCapNoted = true;
  return false;
};

/**
 * One mutable `/input` router. The first path segment selects a host share, so a lease adds or removes
 * a folder while Pi keeps running. Expiry or removal blocks every later open.
 */
class ShareRouter extends VirtualProviderClass {
  shares: Live["shares"];

  constructor(shares: Live["shares"]) {
    super();
    this.shares = shares;
  }

  get readonly() {
    return false;
  }
  get supportsSymlinks() {
    return false;
  }
  get supportsWatch() {
    return false;
  }
  close() {
    return Promise.resolve();
  }
}

/** Forward every filesystem operation the SDK's own read-only provider implements, minus our four. */
const OWN = ["constructor", "readonly", "supportsSymlinks", "supportsWatch", "close"];

for (const operation of Object.getOwnPropertyNames(ReadonlyProvider.prototype).filter(
  (name) => !OWN.includes(name),
))
  ShareRouter.prototype[operation] = function (
    this: ShareRouter,
    path: string,
    ...rest: unknown[]
  ) {
    const settle = (value: unknown) =>
      operation.endsWith("Sync") ? value : Promise.resolve(value);
    const [name, ...tail] = normalizeVfsPath(path).split("/").filter(Boolean);
    const visible = [...this.shares].filter(([, share]) => unexpired([share]).length);

    if (name === undefined) {
      if (operation.startsWith("readdir"))
        return settle(
          formatVirtualEntries(
            visible.map(([share]) => share),
            Boolean((rest[0] as { withFileTypes?: boolean })?.withFileTypes),
          ),
        );
      if (operation.startsWith("stat") || operation.startsWith("lstat"))
        return settle(createVirtualDirStats());
      if (operation.startsWith("realpath")) return settle("/input");
      if (operation.startsWith("access")) return settle(undefined);
      if (operation.startsWith("statfs"))
        return settle({
          blocks: 0,
          bfree: 0,
          bavail: 0,
          files: 0,
          ffree: 0,
          bsize: 4096,
          frsize: 4096,
          namelen: 255,
        });
    }
    const share = visible.find(([shareName]) => shareName === name)?.[1].provider as unknown as
      | Record<string, (path: string, ...rest: unknown[]) => unknown>
      | undefined;
    if (!share)
      throw Object.assign(new Error(`no share named ${name}`), {
        code: "ENOENT",
        errno: -ERRNO.ENOENT,
      });
    return share[operation]!(`/${tail.join("/")}`, ...rest);
  };

export const shareProvider = (hostPath: string, writable: boolean): VirtualProvider =>
  writable ? new RealFSProvider(hostPath) : new ReadonlyProvider(new RealFSProvider(hostPath));

export type Guest = {
  /** Gondolin session id; `gondolin attach <id>` opens an owner terminal in the VM. */
  sessionId: string;
  exec: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  close: () => Promise<void>;
};

const internal = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["255.0.0.0", 8]] as const)
  internal.addSubnet(network, prefix, "ipv4");
internal.addAddress("::1", "ipv6");
const isInternalIp = (ip: string) => internal.check(ip, ip.includes(":") ? "ipv6" : "ipv4");

/**
 * Where requests to a granted secret's hosts go: through speaker's proxy, which holds the value and swaps the agent's
 * placeholder in. `allow` answers for those hosts (undefined for every other host, which the rest of the policy decides);
 * `dispatcher` is the upstream route Gondolin must use for them. The proxy connection is made at first use.
 */
export const secretRoute = (live: Pick<Live, "secretHosts" | "events">, proxy: () => Promise<Dispatcher>) => {
  let viaSpeaker: Dispatcher | undefined;
  const covered = (host: string) =>
    hostMatches(unexpired(live.secretHosts).flatMap((entry) => entry.hosts), host);
  return {
    allow: async (host: string) => {
      if (!covered(host)) return undefined;
      try {
        viaSpeaker ??= await proxy();
        return true;
      } catch (error) {
        // Never fall back to a direct request: the placeholder would reach the real host instead of the secret.
        note(live, `blocked a request to ${host}: ${(error as Error).message}`);
        return false;
      }
    },
    dispatcher: (host: string) => {
      if (!covered(host)) return undefined;
      if (!viaSpeaker) throw new Error(`speaker's proxy is not connected; refusing a direct request to ${host}`);
      return viaSpeaker;
    },
    close: async () => void (await viaSpeaker?.close()),
  };
};

/**
 * Boots the one pinned guest image for a task. Every destination is denied until the live policy view allows it. The
 * agent's speaker token reaches the guest as a placeholder Gondolin substitutes for speaker's host only. Secrets are not
 * handled here at all: requests to a granted secret's hosts go through speaker's proxy (`proxy`), which holds the value.
 */
export const bootGuest = async (
  config: Config,
  live: Live,
  limits: { cpus: number; memoryMiB: number; rootfsGiB: number },
  paths: { work: string; artifacts: string; guestConfig: string; capture: string },
  env: Record<string, string>,
  speaker: { url: string; token: string },
  proxy: () => Promise<Dispatcher>,
): Promise<Guest> => {
  const speakerUrl = new URL(speaker.url);
  const speakerHost = speakerUrl.hostname;
  const getLocalOrigin = () => new URL(`http://${config.localModel.upstream}`).origin;
  const getModelOrigins = () =>
    new Set([
      `http://${config.localModel.guestHost}`,
      getLocalOrigin(),
      ...config.hostedProviders.map((provider) => new URL(provider.baseUrl).origin),
    ]);
  const captureDir = paths.capture;
  mkdirSync(captureDir, { recursive: true });
  const route = secretRoute(live, proxy);
  const { httpHooks, env: secretPlaceholders } = createHttpHooks({
    // Request policy supplies the live domain allow-set. This wildcard keeps Gondolin's IP guard
    // active after that policy permits a host; an empty host list would deny every DNS result.
    allowedHosts: ["*"],
    allowedInternalHosts: ["*"],
    blockInternalRanges: true,
    secrets: { SPEAKER_TOKEN: { hosts: [speakerHost], value: speaker.token } },
    isIpAllowed: (info) => {
      // Deny every IPv6 destination until we implement and test its private-range policy.
      if (!ipv4Destination(info.ip)) return false;
      if (isInternalIp(info.ip)) {
        const currentModelHost = new URL(`http://${config.localModel.upstream}`).hostname;
        return info.hostname === currentModelHost || info.hostname === speakerHost;
      }
      return true;
    },
    isRequestAllowed: async (request) => {
      const url = new URL(request.url);
      if (url.hostname === speakerHost) return speakerRequestAllowed(speakerUrl, url, request.method);
      // A secret's hosts are also in the live host list; this only makes the proxy route fail closed. A hosted model
      // provider is both, so the model request cap below still counts it.
      if ((await route.allow(url.hostname)) === false) return false;
      const localOrigin = getLocalOrigin();
      const guestOrigin = `http://${config.localModel.guestHost}`;
      if (getModelOrigins().has(url.origin) && !countModelRequest(live)) return false;
      if (url.origin === localOrigin || url.origin === guestOrigin) return true;
      const host = url.hostname;
      if (hostMatches(unexpired(live.hosts).map((entry) => entry.host), host)) return true;
      note(live, `blocked a request to ${host}`);
      return false;
    },
    onRequest: (request) => {
      const url = new URL(request.url);
      if (url.origin !== `http://${config.localModel.guestHost}`) return;
      url.host = new URL(`http://${config.localModel.upstream}`).host;
      return new Request(url, request);
    },
  });
  // A request to a granted secret's hosts goes through speaker's proxy, which swaps the placeholder for the value.
  httpHooks.upstreamDispatcher = (request) => route.dispatcher(new URL(request.url).hostname);
  httpHooks.captureBodyLimit = (request, direction) =>
    getModelOrigins().has(new URL(request.url).origin)
      ? (direction === "request" ? 8 : 32) * 1024 * 1024
      : 1024 * 1024;
  httpHooks.onResponseComplete = async (response, request, info) => {
    const responseBody = response ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
    const requestBody = Buffer.from(info.requestBody ?? []);
    const saveBody = (
      direction: string,
      body: Buffer,
      totalBytes: number,
      limitBytes: number,
      contentType: string | null,
      incomplete = false,
    ): CapturedBody | undefined => {
      if (!totalBytes) return;
      const isModel = getModelOrigins().has(new URL(request.url).origin);
      if (
        !isModel &&
        !contentType?.match(
          /^(text\/|application\/(json|[^;]+\+json|xml|javascript|x-www-form-urlencoded)|application\/.*\+xml)/i,
        )
      )
        return;
      const name = `${randomUUID()}.${direction}.bin`;
      writeFileSync(`${paths.capture}/${name}`, body, { flag: "wx" });
      live.httpBodyBytes += body.length;
      return {
        path: `blobs/${name}`,
        ...(contentType ? { contentType } : {}),
        capturedBytes: body.length,
        totalBytes,
        limitBytes,
        truncated: body.length < totalBytes || incomplete,
      };
    };
    const requestBytes = Math.max(info.requestBytes ?? 0, requestBody.length);
    const responseBytes = Math.max(info.bytes ?? 0, responseBody.length);
    const requestCapture = saveBody(
      "request",
      requestBody,
      requestBytes,
      info.requestLimit ?? 0,
      request.headers.get("content-type"),
    );
    const responseCapture = saveBody(
      "response",
      responseBody,
      responseBytes,
      info.responseLimit ?? 0,
      response?.headers.get("content-type") ?? null,
      !info.complete,
    );
    const captureStatus = (total: number, body?: CapturedBody) =>
      !total
        ? ("empty" as const)
        : !body
          ? ("metadata_only" as const)
          : body.truncated
            ? ("truncated" as const)
            : ("complete" as const);
    if (live.httpResponses.length === 1_000) {
      const removed = live.httpResponses.shift()!;
      for (const body of [removed.requestBody, removed.responseBody])
        if (body) {
          rmSync(`${paths.capture}/${body.path.slice("blobs/".length)}`, { force: true });
          live.httpBodyBytes -= body.capturedBytes;
        }
      live.httpResponsesOmitted += 1;
    }
    live.httpResponses.push({
      at: new Date().toISOString(),
      method: request.method,
      destination: new URL(request.url).origin,
      requestHeaders: safeHeaders(request.headers),
      status: response?.status ?? 0,
      responseHeaders: response ? safeHeaders(response.headers) : {},
      durationMs: info.durationMs,
      ...(info.bytes === undefined ? {} : { bytes: info.bytes }),
      complete: info.complete,
      ...(info.error ? { error: info.error } : {}),
      requestCapture: captureStatus(requestBytes, requestCapture),
      responseCapture: captureStatus(responseBytes, responseCapture),
      ...(requestCapture ? { requestBody: requestCapture } : {}),
      ...(responseCapture ? { responseBody: responseCapture } : {}),
    });
  };

  const krun = process.env.PI_V2_VMM === "krun";
  const vm = await VM.create({
    sandbox: {
      vmm: krun ? "krun" : "qemu",
      // Gondolin's QEMU default is microvm (no PCI/SATA/firmware probing). patches/gondolin-0.13.0.patch adds `rtc=on`
      // (without an RTC the guest kernel stalls ~1.6s in rtc_cmos) and boots it with qboot, which loads the image's PVH
      // vmlinux without in-guest decompression. The initramfs must stay small (guest/boot-assets.mjs) or microvm's
      // initrd overwrites the ACPI tables.
      console: "none",
      // Gondolin's QEMU default plus `quiet`: each serial console byte is a trapped port write, and the kernel's boot
      // log alone cost ~0.3s. Warnings, errors, and panics still reach the console.
      // Krun: Gondolin's default krun command line plus `quiet`, and without the i8042 keyboard controller driver, whose
      // probe of libkrun's emulated controller takes ~0.25s.
      append: krun
        ? "console=hvc0 root=/dev/vda rootfstype=ext4 rw init=/init quiet initcall_blacklist=i8042_init"
        : `console=${process.arch === "arm64" ? "ttyAMA0" : "ttyS0"} initramfs_async=1 quiet`,
      imagePath: config.guestImage,
    },
    rootfs: { mode: "cow", size: `${limits.rootfsGiB}G` },
    cpus: limits.cpus,
    memory: `${limits.memoryMiB}M`,
    httpHooks,
    env: {
      BOTTLE_SCHOOL: "1",
      SPEAKER_URL: speaker.url,
      SPEAKER_TOKEN: secretPlaceholders.SPEAKER_TOKEN!,
      ...env,
    },
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
    tcp: {
      hosts: {
        "control.internal": `127.0.0.1:${config.guestPort}`,
      },
    },
    vfs: {
      mounts: {
        "/input": new ShareRouter(live.shares) as unknown as VirtualProvider,
        "/work": new RealFSProvider(paths.work),
        "/output": new RealFSProvider(paths.artifacts),
        "/etc/pi-v2": shareProvider(paths.guestConfig, false),
      },
    },
  });

  return {
    sessionId: vm.id,
    exec: async (command) => {
      const { exitCode, stdout, stderr } = await vm.exec(command);
      return { exitCode, stdout, stderr };
    },
    close: async () => {
      await vm.close();
      await route.close();
    },
  };
};

// One microsandbox VM per task. The guest has no network device: five vsock doors (egress proxy, model endpoint,
// speaker's agent API, the control API, and ssh to speaker's jump server) are its only way out, each served here on a
// unix socket and decided by the live grant view.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import dns from "node:dns";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { BlockList, connect, createServer as createNetServer, isIP, isIPv4, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { buffer } from "node:stream/consumers";
import { promisify } from "node:util";
import { RequestError, Server as ProxyServer } from "proxy-chain";
import type { Sandbox as MicroVm } from "microsandbox";
import { request, type Dispatcher } from "undici";
import { z } from "zod";
import { microsandboxHome, type Config } from "./config.ts";
import { speakerApi } from "./speaker.ts";
import { coversAny, errorBody } from "../../speaker/items.ts";
import { codes, speakerRequestAllowed, unexpired, type Timed } from "./grants.ts";

/** The live grant view the doors read. Each speaker snapshot replaces these entries; every use checks expiry. */
export type Live = {
  hosts: (Timed & { host: string })[];
  /** Granted `secret:` items and the hosts speaker bound them to. Requests to these hosts go through speaker's proxy. */
  secretHosts: (Timed & { name: string; hosts: string[] })[];
  /** Folder grants by share, mounted under /input over SSH through speaker. */
  shares: Map<string, Timed & { writable: boolean }>;
  events: { at: string; text: string }[];
  /** Spend cap: model requests allowed so far, the owner's limit, and whether the refusal was recorded. */
  modelRequests: number;
  maxModelRequests?: number;
  modelCapNoted: boolean;
};

export type Guest = {
  /** The task's throwaway SSH public key; it goes to speaker with the task's requests. */
  sshKey?: string;
  /** The microsandbox name; `attach` turns it into the owner's terminal command. */
  sessionId: string;
  exec: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  close: () => Promise<void>;
};
export type Boot = typeof boot;

export const note = (live: Pick<Live, "events">, text: string) => {
  live.events.push({ at: new Date().toISOString(), text });
  if (live.events.length > 2_000) live.events.splice(0, live.events.length - 2_000);
};

export const countModelRequest = (live: Live) => {
  if (live.maxModelRequests === undefined || live.modelRequests < live.maxModelRequests) {
    live.modelRequests += 1;
    return true;
  }
  if (!live.modelCapNoted) note(live, `model request limit ${live.maxModelRequests} reached; the owner can raise it`);
  live.modelCapNoted = true;
  return false;
};

/**
 * Where requests to a granted secret's hosts go: through speaker's proxy (`proxy`), which holds the value and swaps the agent's placeholder in. `allow` answers for those hosts (undefined for every
 * other host, which the rest of the policy decides); `dispatcher` is the upstream route for them.
 */
export const secretRoute = (live: Pick<Live, "secretHosts" | "events">, proxy: Dispatcher) => {
  const covered = (host: string) =>
    coversAny(
      unexpired(live.secretHosts).flatMap((entry) => entry.hosts),
      host,
    );
  return {
    allow: (host: string) => {
      if (!covered(host)) return undefined;
      return true;
    },
    dispatcher: (host: string) => {
      if (!covered(host)) return undefined;
      return proxy;
    },
    close: async () => void (await proxy.close()),
  };
};

const internal = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  internal.addSubnet(network, prefix, "ipv4");
internal.addAddress("::1", "ipv6");
export const isInternalIp = (ip: string) => internal.check(ip, ip.includes(":") ? "ipv6" : "ipv4");

/** Guest vsock ports, one per door; `socat` in the guest exposes each as a localhost TCP port. */
const DOORS = { egress: [5000, 3128], model: [5001, 80], speaker: [5002, 3129], control: [5003, 3130] } as const;
/** The fifth door: the guest's ssh reaches speaker's jump server through it (`ProxyCommand socat`), for folders over `sshfs`. */
const SSH_VSOCK = 5004;
/** Every VM bottle starts is named with this prefix, so `reconcile` finds the ones a crashed service left behind. */
const VM_PREFIX = "bottle-";
const GUEST_SSH = { key: "/run/speaker/ssh_key", config: "/run/speaker/ssh_config", knownHosts: "/run/speaker/known_hosts" };

/** microsandbox keeps its images and sandbox records here. It refuses a folder other accounts could write. */
const msbHome = () => {
  const dir = microsandboxHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.MSB_HOME = dir;
};

/** A private folder for one VM's door sockets, in the short per-user runtime dir so the socket paths fit any stateRoot. */
const socketFolder = () => mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "bottle-"));

/** What the guest's HTTP proxy does with a host: refuse it, route it through speaker's proxy (a secret host), or go direct. */
export const egressDecision = async (live: Live, route: Pick<ReturnType<typeof secretRoute>, "allow">, host: string) => {
  if (isIP(host) && (!isIPv4(host) || isInternalIp(host))) {
    note(live, `blocked a request to ${host}`);
    return "refuse" as const;
  }
  const viaSpeaker = await route.allow(host);
  if (viaSpeaker !== undefined) return viaSpeaker ? ("speaker" as const) : ("refuse" as const);
  if (
    coversAny(
      unexpired(live.hosts).map((entry) => entry.host),
      host,
    )
  )
    return "direct" as const;
  note(live, `blocked a request to ${host}`);
  return "refuse" as const;
};

/** Direct connections resolve to public IPv4 addresses only. */
const publicLookup = ((hostname: string, options: dns.LookupOptions, callback: (...result: unknown[]) => void) =>
  dns.lookup(hostname, { ...options, family: 4 }, (error, address, family) => {
    const addresses = typeof address === "string" ? [address] : address.map((entry) => entry.address);
    callback(error ?? (addresses.some(isInternalIp) ? new Error(`${hostname} resolves to an internal address`) : null), address, family);
  })) as unknown as typeof dns.lookup;

/** The guest's only route to the internet: allowed hosts go direct, secret hosts go through speaker's proxy, the rest get 403. */
export const egressProxy = (live: Live, route: ReturnType<typeof secretRoute>, speaker: { proxy: string; agentToken: string }) => {
  // Open connections by host. A CONNECT tunnel is checked once, so `sweep` closes any whose host lost its grant.
  const open = new Map<number, string>();
  const proxy = new ProxyServer({
    prepareRequestFunction: async ({ hostname, connectionId }) => {
      const decision = await egressDecision(live, route, hostname);
      if (decision === "refuse")
        throw new RequestError(`${hostname} is not approved for this task. To get access, call request_capability with site:${hostname}.`, 403);
      open.set(connectionId, hostname);
      return decision === "speaker" ? { upstreamProxyUrl: `http://agent:${speaker.agentToken}@${speaker.proxy}` } : { dnsLookup: publicLookup };
    },
  });
  proxy.on("connectionClosed", ({ connectionId }: { connectionId: number }) => open.delete(connectionId));
  const sweep = () => {
    const allowed = [...unexpired(live.hosts).map((entry) => entry.host), ...unexpired(live.secretHosts).flatMap((entry) => entry.hosts)];
    for (const [id, host] of open)
      if (!coversAny(allowed, host)) {
        open.delete(id);
        proxy.closeConnection(id);
        note(live, `closed a connection to ${host}: its grant ended`);
      }
  };
  return Object.assign(proxy, { sweep });
};

/** proxy-chain drops a connection that has no remote address, as every unix socket one does, so each is handed over with a placeholder. */
export const serveEgress = async (proxy: ProxyServer, path: string) => {
  const server = createNetServer((socket) => {
    Object.defineProperty(socket, "remoteAddress", { value: "unix" });
    proxy.server.emit("connection", socket);
  }).listen(path);
  await once(server, "listening");
  return Object.assign(server, { closeAllConnections: () => proxy.closeConnections() });
};

/** Pipes each guest connection on a unix socket to speaker's SSH port. The guest has no network device; this is its only way there. */
const serveSsh = async (path: string, host: string, port: number) => {
  const sockets = new Set<Socket>();
  const server = createNetServer((guest) => {
    const speaker = connect(port, host);
    for (const socket of [guest, speaker]) {
      sockets.add(socket);
      socket.on("close", () => (sockets.delete(socket), guest.destroy(), speaker.destroy())).on("error", () => undefined);
    }
    guest.pipe(speaker).pipe(guest);
  }).listen(path);
  await once(server, "listening");
  return Object.assign(server, { closeAllConnections: () => sockets.forEach((socket) => socket.destroy()) });
};

/** A throwaway SSH key for one task: the private half goes into the VM, the public half to speaker as the agent's `sshKey`. */
const newSshKey = async (dir: string) => {
  const file = `${dir}/ssh_key`;
  await promisify(execFile)("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", file]);
  const key = { private: readFileSync(file, "utf8"), public: readFileSync(`${file}.pub`, "utf8").trim() };
  rmSync(file);
  rmSync(`${file}.pub`);
  return key;
};

/** A door's own refusal, in speaker's error shape. */
const reply = (res: ServerResponse, status: keyof typeof codes, message: string, next?: string) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(errorBody(codes[status], message, next === undefined ? {} : { next })));
/** The model door answers in the OpenAI shape, `{ error: { message } }`, because that is what Pi's model client reads. */
const modelReply = (res: ServerResponse, status: number, message: string) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message } }));
type Reply = (res: ServerResponse, status: keyof typeof codes, message: string) => void;

/** Sends a guest request on to `target` and streams the answer back; with `record`, also appends one line to its `model-calls.jsonl`. */
const forward = async (
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  options: { headers?: Record<string, string>; json?: object; dispatcher?: Dispatcher; record?: { live: Live; file: string }; fail?: Reply } = {},
) => {
  const started = Date.now();
  const sent = await buffer(req);
  // `json` is merged into a JSON request body (the task's SSH key into its requests to speaker).
  const body = options.json ? Buffer.from(JSON.stringify({ ...JSON.parse(sent.toString()), ...options.json })) : sent;
  const { host: _host, connection: _connection, "content-length": _length, ...headers } = req.headers;
  const method = req.method ?? "GET";
  const upstream = await request(target, {
    method: method as Dispatcher.HttpMethod,
    headers: { ...headers, ...options.headers },
    body: body.length ? body : null,
    ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
  }).catch((error: Error) => {
    (options.fail ?? reply)(res, 502, `${target.host} is unreachable: ${error.message}`);
    if (options.record) note(options.record.live, `${target.origin} is unreachable: ${error.message}`);
  });
  if (!upstream) return;
  const { connection: _c, "keep-alive": _k, "transfer-encoding": _t, ...responseHeaders } = upstream.headers;
  res.writeHead(upstream.statusCode, responseHeaders);
  const limit = 32 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  upstream.body.on("data", (chunk: Buffer) => {
    if (total < limit) chunks.push(chunk.subarray(0, limit - total));
    total += chunk.length;
  });
  await pipeline(upstream.body, res).catch(() => undefined); // a dropped guest still leaves its call on record
  // The raw bodies, each cut at a cap: a streamed reply stays as its event stream.
  if (options.record) {
    const request = body.subarray(0, 8 * 1024 * 1024);
    const line = {
      at: new Date().toISOString(),
      status: upstream.statusCode,
      durationMs: Date.now() - started,
      request: request.toString(),
      reply: Buffer.concat(chunks).toString(),
      truncated: body.length > request.length || total > limit,
    };
    appendFileSync(options.record.file, `${JSON.stringify(line)}\n`);
  }
};

/**
 * The model endpoint: the local model, or `/hosted/<provider>/<path>` sent to speaker's `<service>/<path>` as the task's
 * agent (speaker checks the service grant and adds the provider's key). Each request counts against the task's cap; a
 * refused one gets a 429 that says so.
 */
export const modelDoor =
  (config: Config, live: Live, speaker: { url: string; agentToken: string }, modelCalls: string): RequestListener =>
  async (req, res) => {
    const path = req.url ?? "/";
    const provider = config.hostedProviders.find((entry) => path.startsWith(`/hosted/${entry.id}/`));
    if (!provider && !config.localModel.upstream) return void modelReply(res, 404, "this bottle has no local model; use a hosted one");
    const target = provider
      ? new URL(`/${provider.service}${path.slice(`/hosted/${provider.id}`.length)}`, speaker.url)
      : new URL(path, `http://${config.localModel.upstream}`);
    // The agent token goes to speaker's origin only, and only under the provider's service (no `..` out of it).
    if (provider && (target.origin !== new URL(speaker.url).origin || !target.pathname.startsWith(`/${provider.service}/`)))
      return void modelReply(res, 400, `a hosted model path stays under /hosted/${provider.id}/`);
    if (!countModelRequest(live)) return void modelReply(res, 429, `model request limit ${live.maxModelRequests} reached; the owner can raise it`);
    await forward(req, res, target, {
      ...(provider ? { headers: { authorization: `Bearer ${speaker.agentToken}` } } : {}),
      record: { live, file: modelCalls },
      fail: modelReply,
    });
  };

/**
 * Speaker's agent API for the guest, with the task's real agent token added here. The task's SSH public key rides along on
 * its requests, so a `folder:` grant is deliverable over SSH.
 */
export const speakerDoor =
  (speaker: { url: string; agentToken: string }, sshKey: string, modelServices: string[]): RequestListener =>
  async (req, res) => {
    const target = new URL(req.url ?? "/", speaker.url);
    if (!speakerRequestAllowed(new URL(speaker.url), target, req.method ?? "GET", modelServices))
      return void reply(res, 403, "this speaker path is not available to a sandboxed task");
    const requests = req.method === "POST" && target.pathname === "/_speaker/requests";
    await forward(req, res, target, {
      headers: { authorization: `Bearer ${speaker.agentToken}` },
      ...(requests ? { json: { sshKey } } : {}),
    });
  };

/**
 * Keeps the guest's folders in step with `live.shares`: each active grant is mounted, a mode change is remounted, and a
 * mount whose grant ended (or whose session speaker ended) is removed or made again. The guest's own mount table is the
 * state. A failed mount is noted once and retried (speaker may not have installed the key yet).
 */
export const folderSync = (
  live: Live,
  guest: {
    /** Folders mounted now, each with whether it is read-write. */
    mounted: () => Promise<Map<string, boolean>>;
    mount: (share: string, writable: boolean) => Promise<void>;
    unmount: (share: string) => Promise<void>;
  },
  retryMs = 3_000,
) => {
  const failing = new Map<string, number>();
  let used = false;
  return async () => {
    const wanted = new Map([...live.shares].filter(([, share]) => unexpired([share]).length).map(([name, share]) => [name, share.writable]));
    if (!wanted.size && !used) return;
    const mounted = await guest.mounted();
    for (const share of failing.keys()) if (!wanted.has(share)) failing.delete(share);
    for (const [share, writable] of mounted)
      if (wanted.get(share) !== writable) {
        mounted.delete(share);
        await guest.unmount(share).then(
          () => note(live, `unmounted /input/${share}`),
          (error: Error) => note(live, `could not unmount /input/${share}: ${error.message}`),
        );
      }
    for (const [share, writable] of wanted) {
      if (mounted.has(share) || Date.now() < (failing.get(share) ?? 0)) continue;
      try {
        await guest.mount(share, writable);
        used = true;
        failing.delete(share);
        note(live, `mounted /input/${share} ${writable ? "read-write" : "read-only"} over SSH`);
      } catch (error) {
        if (!failing.has(share)) note(live, `could not mount folder ${share}: ${(error as Error).message}`);
        failing.set(share, Date.now() + retryMs);
      }
    }
  };
};

/** The part of speaker's `/catalog` that folder mounts read: each `ssh:`/`folder:` grant's commands. */
const Catalog = z.object({
  ssh: z.array(z.object({ item: z.string(), commands: z.array(z.string()), knownHosts: z.object({ line: z.string() }) })),
});

/** The guest side of `folderSync`: mounts, unmounts and lists `/input/<share>` with `sshfs` over the SSH door. */
const guestFolders = (vm: MicroVm, config: Config, agentToken: string) => {
  const run = async (command: string) => {
    const result = await vm.shell(command);
    if (result.code !== 0) throw new Error(result.stderr().trim() || `exit ${result.code}`);
  };
  return {
    // speaker's /catalog gives the complete sshfs command line for the grant, with the jump server's pinned host key.
    mount: async (share: string, writable: boolean) => {
      const response = await speakerApi(config, agentToken).catalog.$get({}, { init: { signal: AbortSignal.timeout(10_000) } });
      if (!response.ok) throw new Error(`speaker GET catalog returned ${response.status}`);
      const item = `folder:${share}${writable ? ":rw" : ""}`;
      const grant = Catalog.parse(await response.json()).ssh.find((entry) => entry.item === item);
      const command = grant?.commands[0];
      if (!grant || !command?.startsWith("sshfs ")) throw new Error(`speaker has no sshfs command for ${item} yet`);
      const sshfs = command
        .replace("<known_hosts>", () => GUEST_SSH.knownHosts)
        .replace("<key>", () => GUEST_SSH.key)
        .replace("<mountpoint>", () => `/input/${share}`)
        .replace("sshfs ", `sshfs -F ${GUEST_SSH.config}${writable ? "" : " -o ro"} `);
      await run(`mkdir -p /input/${share} && echo '${grant.knownHosts.line}' > ${GUEST_SSH.knownHosts} && ${sshfs}`);
    },
    // speaker ending a session takes its mount with it, so there may be nothing left to unmount.
    unmount: (share: string) => run(`if grep -q ' /input/${share} ' /proc/mounts; then fusermount3 -uz /input/${share}; fi`),
    mounted: async () => {
      const table = await vm.shell("grep ' fuse.sshfs ' /proc/mounts || true");
      return new Map(
        table
          .stdout()
          .split("\n")
          .flatMap((line) => {
            const [, path, , options] = line.split(" ");
            return path?.startsWith("/input/") ? [[path.slice("/input/".length), options!.split(",").includes("rw")] as const] : [];
          }),
      );
    },
  };
};

/** Starts a server on a unix socket that a vsock route reaches; a failed request ends as a 502, never an unhandled error. */
export const listen = async (path: string, handler: RequestListener, fail: Reply = reply) => {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error: Error) => (res.headersSent ? res.destroy() : fail(res, 502, error.message)));
  }).listen(path);
  await once(server, "listening");
  return server;
};

/**
 * Starts one VM for a task: deny-by-default egress decided by `live` (hosts, secret hosts routed through `proxy`, the
 * model-request cap), folders from `live.shares` mounted under /input and following later changes, `paths` mounted at
 * /work, /output and /etc/bottle, and model calls appended to `paths.modelCalls`. Grant changes need no VM call: the doors re-read `live` on every use.
 */
export async function boot(
  config: Config,
  live: Live,
  limits: { cpus: number; memoryMiB: number; rootfsGiB: number },
  paths: { work: string; artifacts: string; guestConfig: string; modelCalls: string },
  env: Record<string, string>,
  speaker: { url: string; agentToken: string; ca: string },
  proxy: Dispatcher,
): Promise<Guest> {
  msbHome();
  const { MiB, Sandbox } = await import("microsandbox");
  const name = `${VM_PREFIX}${randomBytes(4).toString("hex")}`;
  const dir = paths.work.slice(0, paths.work.lastIndexOf("/"));
  const socketDir = socketFolder();
  const route = secretRoute(live, proxy);
  const egress = egressProxy(live, route, {
    proxy: `${new URL(config.speaker.url).hostname}:${config.speaker.proxyPort}`,
    agentToken: speaker.agentToken,
  });
  // Folders arrive over SSH through speaker (see `folderSync`).
  const key = await newSshKey(dir);
  const servers = [
    await serveEgress(egress, `${socketDir}/egress.sock`),
    await listen(`${socketDir}/model.sock`, modelDoor(config, live, speaker, paths.modelCalls), modelReply),
    await listen(
      `${socketDir}/speaker.sock`,
      speakerDoor(
        speaker,
        key.public,
        config.hostedProviders.map((provider) => provider.service),
      ),
    ),
    await listen(`${socketDir}/control.sock`, (req, res) => forward(req, res, new URL(req.url ?? "/", `http://127.0.0.1:${config.guestPort}`))),
    await serveSsh(`${socketDir}/ssh.sock`, new URL(config.speaker.url).hostname, config.speaker.sshPort),
  ];
  let folders: NodeJS.Timeout | undefined;
  // Revoking or expiring a grant closes the task's open connections to that host within a second.
  const sweeper = setInterval(egress.sweep, 1_000);
  let sandbox: MicroVm | undefined;
  // Stops the VM, removes it, and stops the doors, whatever step fails first; also the way a failed boot cleans up.
  const destroy = async () => {
    clearInterval(folders);
    clearInterval(sweeper);
    try {
      try {
        await sandbox?.stop();
        await sandbox?.waitUntilStopped();
      } finally {
        await Sandbox.remove(name);
      }
    } finally {
      await Promise.all([route.close(), ...servers.map((server) => (server.close(), server.closeAllConnections()))]).finally(() =>
        rmSync(socketDir, { recursive: true, force: true }),
      );
    }
  };

  try {
    // Speaker's proxy certificate authority: secret hosts are TLS-terminated there, so the guest must trust it.
    const { ca } = speaker;
    const caPath = "/usr/local/share/ca-certificates/speaker-proxy.crt";
    const localProxy = `http://127.0.0.1:${DOORS.egress[1]}`;
    const noProxy = `127.0.0.1,localhost,${config.localModel.guestHost}`;
    const guestEnv: Record<string, string> = {
      BOTTLE: "1",
      SPEAKER_URL: `http://127.0.0.1:${DOORS.speaker[1]}`,
      SPEAKER_TOKEN: "placeholder: the host adds the task's token",
      HTTP_PROXY: localProxy,
      HTTPS_PROXY: localProxy,
      http_proxy: localProxy,
      https_proxy: localProxy,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      NODE_USE_ENV_PROXY: "1",
      ...(ca ? { NODE_EXTRA_CA_CERTS: caPath } : {}),
      ...env,
      BOTTLE_CONTROL: `http://127.0.0.1:${DOORS.control[1]}`,
    };
    let builder = Sandbox.builder(name)
      .imageWith((image) => image.oci(config.guestImage).rootDisk(limits.rootfsGiB * 1024))
      .pullPolicy("never")
      .cpus(limits.cpus)
      .memory(MiB(limits.memoryMiB))
      .disableNetwork()
      .volume("/work", (mount) => mount.bind(paths.work))
      .volume("/output", (mount) => mount.bind(paths.artifacts))
      .volume("/etc/bottle", (mount) => mount.bind(paths.guestConfig).readonly());
    for (const [door, [port]] of Object.entries(DOORS)) builder = builder.vsock(`${socketDir}/${door}.sock`, port);
    if (key) builder = builder.vsock(`${socketDir}/ssh.sock`, SSH_VSOCK);
    for (const [key, value] of Object.entries(guestEnv)) builder = builder.env(key, value);
    sandbox = await builder.create();
    if (ca) await sandbox.fs().write(caPath, ca);
    const doors = Object.values(DOORS)
      .map(([vsock, port]) => `setsid socat TCP-LISTEN:${port},fork,reuseaddr,bind=127.0.0.1 VSOCK-CONNECT:2:${vsock} >/dev/null 2>&1 </dev/null &`)
      .join("\n");
    // The SSH key is root-only, and ssh reaches speaker through the vsock door, never a network.
    const ssh = key
      ? `umask 077\nmkdir -p /run/speaker\ncat > ${GUEST_SSH.key} <<'KEY'\n${key.private}KEY\nprintf 'Host *\\n  ProxyCommand socat - VSOCK-CONNECT:2:${SSH_VSOCK}\\n  ServerAliveInterval 5\\n  ServerAliveCountMax 2\\n' > ${GUEST_SSH.config}\n`
      : "";
    const started = await sandbox.shell(
      `set -e\necho '127.0.0.1 ${config.localModel.guestHost}' >> /etc/hosts\n${ca ? "update-ca-certificates >/dev/null\n" : ""}${ssh}${doors}`,
    );
    if (started.code !== 0) throw new Error(`guest setup failed: ${started.stderr()}`);
    if (key) {
      const sync = folderSync(live, guestFolders(sandbox, config, speaker.agentToken));
      let busy = false;
      folders = setInterval(() => {
        if (busy) return;
        busy = true;
        void sync().finally(() => (busy = false));
      }, 1_000);
    }
  } catch (error) {
    await destroy().catch(() => undefined); // the boot error is the one to report
    throw error;
  }
  const vm = sandbox;
  return {
    ...(key ? { sshKey: key.public } : {}),
    sessionId: name,
    exec: async (command) => {
      const result = await vm.shell(command);
      return { exitCode: result.code, stdout: result.stdout(), stderr: result.stderr() };
    },
    close: destroy,
  };
}

/** The owner's terminal into a running guest, as a command to spawn. */
export const attach = (sessionId: string, command: string[]) => ({
  file: "env",
  args: [`MSB_HOME=${microsandboxHome()}`, `${import.meta.dirname}/../node_modules/.bin/msb`, "exec", "-t", sessionId, "--", ...command],
});

/** Removes the VMs a crashed service left behind; returns how many. */
export const reconcile = async () => {
  msbHome();
  const { Sandbox } = await import("microsandbox");
  const stale = (await Sandbox.list()).sandboxes.filter((handle) => handle.name.startsWith(VM_PREFIX));
  await Promise.all(stale.map((handle) => Sandbox.remove(handle.name)));
  return stale.length;
};

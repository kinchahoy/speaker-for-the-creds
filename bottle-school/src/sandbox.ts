// One microsandbox VM per task. The guest has no network device: five vsock doors (egress proxy, model endpoint,
// speaker's agent API, the control API, and ssh to speaker's jump server) are its only way out, each served here on a
// unix socket and decided by the live lease view.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import dns from "node:dns";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { BlockList, connect, createServer as createNetServer, isIP, type Socket } from "node:net";
import { pipeline } from "node:stream/promises";
import { buffer } from "node:stream/consumers";
import { promisify } from "node:util";
import { RequestError, Server as ProxyServer } from "proxy-chain";
import type { Sandbox as MicroVm } from "microsandbox";
import { request, type Dispatcher } from "undici";
import { z } from "zod";
import type { Config } from "./config.ts";
import { hostMatches, ipv4Destination, speakerRequestAllowed, unexpired, type Timed } from "./leases.ts";
import { recordHttp, type HttpResponseRecord } from "./trace.ts";

/** The live lease view the doors read. Each speaker snapshot replaces these entries; every use checks expiry. */
export type Live = {
  hosts: (Timed & { host: string })[];
  /** Granted `secret:` items and the hosts speaker bound them to. Requests to these hosts go through speaker's proxy. */
  secretHosts: (Timed & { name: string; hosts: string[] })[];
  /** Folder grants by share, mounted under /input over SSH through speaker. */
  shares: Map<string, Timed & { writable: boolean }>;
  events: { at: string; text: string }[];
  httpResponses: HttpResponseRecord[];
  httpResponsesOmitted: number;
  httpBodyBytes: number;
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
 * Where requests to a granted secret's hosts go: through speaker's proxy, which holds the value and swaps the agent's
 * placeholder in. `allow` answers for those hosts (undefined for every other host, which the rest of the policy decides);
 * `dispatcher` is the upstream route for them. The proxy connection is made at first use.
 */
export const secretRoute = (live: Pick<Live, "secretHosts" | "events">, proxy: () => Promise<Dispatcher>) => {
  let viaSpeaker: Dispatcher | undefined;
  const covered = (host: string) => hostMatches(unexpired(live.secretHosts).flatMap((entry) => entry.hosts), host);
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

const internal = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["255.0.0.0", 8]] as const)
  internal.addSubnet(network, prefix, "ipv4");
internal.addAddress("::1", "ipv6");
export const isInternalIp = (ip: string) => internal.check(ip, ip.includes(":") ? "ipv6" : "ipv4");

/** Guest vsock ports, one per door; `socat` in the guest exposes each as a localhost TCP port. */
const DOORS = { egress: [5000, 3128], model: [5001, 80], speaker: [5002, 3129], control: [5003, 3130] } as const;
/** The fifth door: the guest's ssh reaches speaker's jump server through it (`ProxyCommand socat`), for folders over `sshfs`. */
const SSH_VSOCK = 5004;
const GUEST_SSH = { key: "/run/speaker/ssh_key", config: "/run/speaker/ssh_config", knownHosts: "/run/speaker/known_hosts" };

/** microsandbox keeps its images and sandbox records here. It refuses a folder other accounts could write. */
const msbHome = (config: Config) => {
  const dir = `${config.stateRoot}/microsandbox`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.MSB_HOME = dir;
};

/** What the guest's HTTP proxy does with a host: refuse it, route it through speaker's proxy (a secret host), or go direct. */
export const egressDecision = async (live: Live, route: Pick<ReturnType<typeof secretRoute>, "allow">, host: string) => {
  if (isIP(host) && (!ipv4Destination(host) || isInternalIp(host))) {
    note(live, `blocked a request to ${host}`);
    return "refuse" as const;
  }
  const viaSpeaker = await route.allow(host);
  if (viaSpeaker !== undefined) return viaSpeaker ? ("speaker" as const) : ("refuse" as const);
  if (hostMatches(unexpired(live.hosts).map((entry) => entry.host), host)) return "direct" as const;
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
export const egressProxy = (live: Live, route: ReturnType<typeof secretRoute>, speaker: { proxy?: string; token: string }) =>
  new ProxyServer({
    prepareRequestFunction: async ({ hostname }) => {
      const decision = await egressDecision(live, route, hostname);
      if (decision === "refuse") throw new RequestError(`${hostname} is not approved for this task`, 403);
      return decision === "speaker" ? { upstreamProxyUrl: `http://agent:${speaker.token}@${speaker.proxy}` } : { dnsLookup: publicLookup };
    },
  });

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

const headersOf = (headers: IncomingHttpHeaders) =>
  new Headers(Object.entries(headers).flatMap(([name, value]) => (value === undefined ? [] : [[name, [value].flat().join(", ")]])));
const reply = (res: ServerResponse, status: number, message: string) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message } }));

/** Sends a guest request on to `target` and streams the answer back; with `record`, also notes it for trace.jsonl. */
const forward = async (
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  options: { headers?: Record<string, string>; json?: object; dispatcher?: Dispatcher; record?: { live: Live; dir: string } } = {},
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
    reply(res, 502, `${target.host} is unreachable: ${error.message}`);
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
  const complete = await pipeline(upstream.body, res).then(() => true, () => false);
  if (options.record)
    recordHttp(
      options.record.live,
      options.record.dir,
      true,
      { method, url: target.href, headers: headersOf(req.headers) },
      { status: upstream.statusCode, headers: headersOf(upstream.headers) },
      body.subarray(0, 8 * 1024 * 1024),
      Buffer.concat(chunks),
      { durationMs: Date.now() - started, bytes: total, requestBytes: body.length, requestLimit: 8 * 1024 * 1024, responseLimit: limit, complete },
    );
};

/**
 * The model endpoint: the local model, or `/hosted/<provider>/...` through speaker's proxy (which holds the key). Each
 * request counts against the task's cap; a refused one gets a 429 that says so.
 */
export const modelDoor = (config: Config, live: Live, route: ReturnType<typeof secretRoute>, dir: string): RequestListener =>
  async (req, res) => {
    const path = req.url ?? "/";
    const provider = config.hostedProviders.find((entry) => path.startsWith(`/hosted/${entry.id}/`));
    const target = provider
      ? new URL(path.slice(`/hosted/${provider.id}`.length), provider.baseUrl)
      : new URL(path, `http://${config.localModel.upstream}`);
    if (provider && (await route.allow(provider.host)) !== true)
      return void reply(res, 403, `the ${provider.credential} secret is not granted to this task`);
    if (!countModelRequest(live))
      return void reply(res, 429, `model request limit ${live.maxModelRequests} reached; the owner can raise it`);
    const dispatcher = provider ? route.dispatcher(provider.host) : undefined;
    await forward(req, res, target, { ...(dispatcher ? { dispatcher } : {}), record: { live, dir } });
  };

/**
 * Speaker's agent API for the guest, with the task's real token added here. The task's SSH public key rides along on
 * its requests, so a `folder:` grant is deliverable over SSH.
 */
export const speakerDoor = (speaker: { url: string; token: string }, sshKey?: string): RequestListener => async (req, res) => {
  const target = new URL(req.url ?? "/", speaker.url);
  if (!speakerRequestAllowed(new URL(speaker.url), target, req.method ?? "GET"))
    return void reply(res, 403, "this speaker path is not available to a sandboxed task");
  const requests = req.method === "POST" && target.pathname === "/_speaker/requests";
  await forward(req, res, target, {
    headers: { authorization: `Bearer ${speaker.token}` },
    ...(sshKey && requests ? { json: { sshKey } } : {}),
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

const Me = z.object({
  ssh: z.array(z.object({ item: z.string(), commands: z.array(z.string()), knownHosts: z.object({ line: z.string() }) })),
});

/** Starts a server on a unix socket that a vsock route reaches; a failed request ends as a 502, never an unhandled error. */
export const listen = async (path: string, handler: RequestListener) => {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error: Error) => (res.headersSent ? res.destroy() : reply(res, 502, error.message)));
  }).listen(path);
  await once(server, "listening");
  return server;
};

/**
 * Starts one VM for a task: deny-by-default egress decided by `live` (hosts, secret hosts routed through `proxy`, the
 * model-request cap), folders from `live.shares` mounted under /input and following later changes, `paths` mounted at
 * /work, /output and /etc/bottle-school, and model request bodies recorded into `live.httpResponses` with their blobs under
 * `paths.capture`. Grant changes need no VM call: the doors re-read `live` on every use.
 */
export async function boot(
  config: Config,
  live: Live,
  limits: { cpus: number; memoryMiB: number; rootfsGiB: number },
  paths: { work: string; artifacts: string; guestConfig: string; capture: string },
  env: Record<string, string>,
  speaker: { url: string; token: string },
  proxy: () => Promise<Dispatcher>,
): Promise<Guest> {
  msbHome(config);
  const { MiB, Sandbox } = await import("microsandbox");
  const name = `bs-${randomBytes(4).toString("hex")}`;
  const dir = paths.work.slice(0, paths.work.lastIndexOf("/"));
  mkdirSync(paths.capture, { recursive: true });
  const route = secretRoute(live, proxy);
  const proxyPort = config.speaker.proxyPort;
  const egress = egressProxy(live, route, {
    ...(proxyPort ? { proxy: `${new URL(config.speaker.url).hostname}:${proxyPort}` } : {}),
    token: speaker.token,
  });
  // Folders arrive over SSH through speaker (see `folderSync`); without speaker.sshPort the guest has no way to them.
  const sshPort = config.speaker.sshPort;
  const key = sshPort ? await newSshKey(dir) : undefined;
  const servers = [
    await serveEgress(egress, `${dir}/egress.sock`),
    await listen(`${dir}/model.sock`, modelDoor(config, live, route, paths.capture)),
    await listen(`${dir}/speaker.sock`, speakerDoor(speaker, key?.public)),
    await listen(`${dir}/control.sock`, (req, res) => forward(req, res, new URL(req.url ?? "/", `http://127.0.0.1:${config.guestPort}`))),
    ...(sshPort ? [await serveSsh(`${dir}/ssh.sock`, new URL(config.speaker.url).hostname, sshPort)] : []),
  ];
  let folders: NodeJS.Timeout | undefined;
  const stopDoors = () => {
    clearInterval(folders);
    return Promise.all([route.close(), ...servers.map((server) => (server.close(), server.closeAllConnections()))]);
  };

  let sandbox: MicroVm | undefined;
  try {
    // Speaker's proxy certificate authority: secret hosts are TLS-terminated there, so the guest must trust it.
    const ca = proxyPort ? await fetch(`${config.speaker.url}/_speaker/proxy/ca.pem`).then((response) => response.text()) : "";
    const caPath = "/usr/local/share/ca-certificates/speaker-proxy.crt";
    const localProxy = `http://127.0.0.1:${DOORS.egress[1]}`;
    const noProxy = `127.0.0.1,localhost,${config.localModel.guestHost}`;
    const guestEnv: Record<string, string> = {
      BOTTLE_SCHOOL: "1",
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
      BOTTLE_SCHOOL_CONTROL: `http://127.0.0.1:${DOORS.control[1]}`,
    };
    let builder = Sandbox.builder(name)
      .imageWith((image) => image.oci(config.guestImage).rootDisk(limits.rootfsGiB * 1024))
      .pullPolicy("never")
      .cpus(limits.cpus)
      .memory(MiB(limits.memoryMiB))
      .disableNetwork()
      .volume("/work", (mount) => mount.bind(paths.work))
      .volume("/output", (mount) => mount.bind(paths.artifacts))
      .volume("/etc/bottle-school", (mount) => mount.bind(paths.guestConfig).readonly());
    for (const [door, [port]] of Object.entries(DOORS)) builder = builder.vsock(`${dir}/${door}.sock`, port);
    if (key) builder = builder.vsock(`${dir}/ssh.sock`, SSH_VSOCK);
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
      const vm = sandbox;
      const run = async (command: string) => {
        const result = await vm.shell(command);
        if (result.code !== 0) throw new Error(result.stderr().trim() || `exit ${result.code}`);
      };
      const sync = folderSync(live, {
        // speaker's own /me gives the complete sshfs command line for the grant, with the jump server's pinned host key.
        mount: async (share, writable) => {
          const response = await fetch(`${config.speaker.url}/_speaker/me`, {
            headers: { authorization: `Bearer ${speaker.token}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) throw new Error(`speaker GET me returned ${response.status}`);
          const item = `folder:${share}${writable ? ":rw" : ""}`;
          const grant = Me.parse(await response.json()).ssh.find((entry) => entry.item === item);
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
        unmount: (share) => run(`if grep -q ' /input/${share} ' /proc/mounts; then fusermount3 -uz /input/${share}; fi`),
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
      });
      let busy = false;
      folders = setInterval(() => {
        if (busy) return;
        busy = true;
        void sync().finally(() => (busy = false));
      }, 1_000);
    }
  } catch (error) {
    await sandbox?.stop().then(() => sandbox?.waitUntilStopped()).catch(() => undefined);
    await Sandbox.remove(name).catch(() => undefined);
    await stopDoors();
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
    close: async () => {
      clearInterval(folders);
      try {
        await vm.stop();
        await vm.waitUntilStopped();
        await Sandbox.remove(name);
      } finally {
        await stopDoors();
      }
    },
  };
}

/** The owner's terminal into a running guest, as a command to spawn. */
export const attach = (config: Config, sessionId: string, command: string[]) => ({
  file: "env",
  args: [`MSB_HOME=${config.stateRoot}/microsandbox`, `${import.meta.dirname}/../node_modules/.bin/msb`, "exec", "-t", sessionId, "--", ...command],
});

/** Removes the VMs a crashed service left behind; returns how many. */
export const reconcile = async (config: Config) => {
  msbHome(config);
  const { Sandbox } = await import("microsandbox");
  const stale = (await Sandbox.list()).sandboxes.filter((handle) => handle.name.startsWith("bs-"));
  await Promise.all(stale.map((handle) => Sandbox.remove(handle.name)));
  return stale.length;
};

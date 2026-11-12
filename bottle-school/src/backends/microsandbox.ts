import { randomBytes } from "node:crypto";
import dns from "node:dns";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { createServer as createNetServer, isIP } from "node:net";
import { pipeline } from "node:stream/promises";
import { buffer } from "node:stream/consumers";
import { RequestError, Server as ProxyServer } from "proxy-chain";
import type { Sandbox as MicroVm } from "microsandbox";
import { request, type Dispatcher } from "undici";
import { countModelRequest, isInternalIp, note, recordHttp, secretRoute, type Backend, type Live } from "../backend.ts";
import type { Config } from "../config.ts";
import { hostMatches, ipv4Destination, speakerRequestAllowed, unexpired } from "../leases.ts";

/** Guest vsock ports, one per door; `socat` in the guest exposes each as a localhost TCP port. */
const DOORS = { egress: [5000, 3128], model: [5001, 80], speaker: [5002, 3129], control: [5003, 3130] } as const;

/** microsandbox keeps its images and sandbox records here. It refuses a folder other accounts could write. */
const home = (config: Config) => {
  const dir = `${config.stateRoot}/microsandbox`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.MSB_HOME = dir;
  return dir;
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
    callback(
      error ?? (addresses.some(isInternalIp) ? new Error(`${hostname} resolves to an internal address`) : null),
      address,
      family,
    );
  })) as unknown as typeof dns.lookup;

/** The guest's only route to the internet: allowed hosts go direct, secret hosts go through speaker's proxy, the rest get 403. */
export const egressProxy = (live: Live, route: ReturnType<typeof secretRoute>, speaker: { proxy?: string; token: string }) =>
  new ProxyServer({
    prepareRequestFunction: async ({ hostname }) => {
      const decision = await egressDecision(live, route, hostname);
      if (decision === "refuse") throw new RequestError(`${hostname} is not approved for this task`, 403);
      return decision === "speaker"
        ? { upstreamProxyUrl: `http://agent:${speaker.token}@${speaker.proxy}` }
        : { dnsLookup: publicLookup };
    },
  });

/** proxy-chain drops a connection that has no remote address, as every unix socket one does, so each is handed over with a placeholder. */
export const serveEgress = async (proxy: ProxyServer, path: string) => {
  const server = createNetServer((socket) => {
    Object.defineProperty(socket, "remoteAddress", { value: "unix" });
    proxy.server.emit("connection", socket);
  });
  server.listen(path);
  await once(server, "listening");
  return Object.assign(server, { closeAllConnections: () => proxy.closeConnections() });
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
  options: { headers?: Record<string, string>; dispatcher?: Dispatcher; record?: { live: Live; dir: string } } = {},
) => {
  const started = Date.now();
  const body = await buffer(req);
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

/** Speaker's agent API for the guest: the same paths the Gondolin backend allows, with the task's real token added here. */
const speakerDoor = (speaker: { url: string; token: string }): RequestListener => async (req, res) => {
  const target = new URL(req.url ?? "/", speaker.url);
  if (!speakerRequestAllowed(new URL(speaker.url), target, req.method ?? "GET"))
    return void reply(res, 403, "this speaker path is not available to a sandboxed task");
  await forward(req, res, target, { headers: { authorization: `Bearer ${speaker.token}` } });
};

/** Starts a server on a unix socket that a vsock route reaches; a failed request ends as a 502, never an unhandled error. */
export const listen = async (path: string, handler: RequestListener) => {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error: Error) => (res.headersSent ? res.destroy() : reply(res, 502, error.message)));
  });
  server.listen(path);
  await once(server, "listening");
  return server;
};

const boot: Backend["boot"] = async (config, live, limits, paths, env, speaker, proxy) => {
  home(config);
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
  const servers = [
    await serveEgress(egress, `${dir}/egress.sock`),
    await listen(`${dir}/model.sock`, modelDoor(config, live, route, paths.capture)),
    await listen(`${dir}/speaker.sock`, speakerDoor(speaker)),
    await listen(`${dir}/control.sock`, (req, res) => forward(req, res, new URL(req.url ?? "/", `http://127.0.0.1:${config.guestPort}`))),
  ];
  const stopDoors = () =>
    Promise.all([route.close(), ...servers.map((server) => (server.close(), server.closeAllConnections()))]);

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
      PI_V2_CONTROL: `http://127.0.0.1:${DOORS.control[1]}`,
    };
    let builder = Sandbox.builder(name)
      .imageWith((image) => image.oci(config.guestImage).rootDisk(limits.rootfsGiB * 1024))
      .pullPolicy("never")
      .cpus(limits.cpus)
      .memory(MiB(limits.memoryMiB))
      .disableNetwork()
      .volume("/work", (mount) => mount.bind(paths.work))
      .volume("/output", (mount) => mount.bind(paths.artifacts))
      .volume("/etc/pi-v2", (mount) => mount.bind(paths.guestConfig).readonly());
    for (const [door, [port]] of Object.entries(DOORS)) builder = builder.vsock(`${dir}/${door}.sock`, port);
    for (const [key, value] of Object.entries(guestEnv)) builder = builder.env(key, value);
    sandbox = await builder.create();
    if (ca) await sandbox.fs().write(caPath, ca);
    const doors = Object.values(DOORS)
      .map(([vsock, port]) => `setsid socat TCP-LISTEN:${port},fork,reuseaddr,bind=127.0.0.1 VSOCK-CONNECT:2:${vsock} >/dev/null 2>&1 </dev/null &`)
      .join("\n");
    const started = await sandbox.shell(
      `set -e\necho '127.0.0.1 ${config.localModel.guestHost}' >> /etc/hosts\n${ca ? "update-ca-certificates >/dev/null\n" : ""}${doors}`,
    );
    if (started.code !== 0) throw new Error(`guest setup failed: ${started.stderr()}`);
  } catch (error) {
    await sandbox?.stop().then(() => sandbox?.waitUntilStopped()).catch(() => undefined);
    await Sandbox.remove(name).catch(() => undefined);
    await stopDoors();
    throw error;
  }
  const vm = sandbox;
  return {
    sessionId: name,
    exec: async (command) => {
      const result = await vm.shell(command);
      return { exitCode: result.code, stdout: result.stdout(), stderr: result.stderr() };
    },
    close: async () => {
      try {
        await vm.stop();
        await vm.waitUntilStopped();
        await Sandbox.remove(name);
      } finally {
        await stopDoors();
      }
    },
  };
};

export const microsandbox: Backend = {
  boot,
  folders: false,
  attach: (config, sessionId, command) => ({
    file: "env",
    args: [`MSB_HOME=${config.stateRoot}/microsandbox`, `${import.meta.dirname}/../../node_modules/.bin/msb`, "exec", "-t", sessionId, "--", ...command],
  }),
  reconcile: async (config) => {
    home(config);
    const { Sandbox } = await import("microsandbox");
    const stale = (await Sandbox.list()).sandboxes.filter((handle) => handle.name.startsWith("bs-"));
    await Promise.all(stale.map((handle) => Sandbox.remove(handle.name)));
    return stale.length;
  },
};

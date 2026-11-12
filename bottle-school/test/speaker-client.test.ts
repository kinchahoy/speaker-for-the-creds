import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { setTimeout as sleep } from "node:timers/promises";
import { fetch as undiciFetch } from "undici";
import { serve } from "../../speaker/node_modules/@hono/node-server/dist/index.mjs";
import { createApp, readConfig } from "../../speaker/server.ts";
// After speaker: its proxy module loads the reflect polyfill that x509 needs.
import * as x509 from "../../speaker/node_modules/@peculiar/x509/build/index.js";
import { setOwnerPassword } from "../../speaker/test/owner.ts";
import type { Config } from "../src/config.ts";
import { secretRoute } from "../src/sandbox.ts";
import { launchRequest, Template } from "../src/leases.ts";
import { Catalog, writeGuestConfig } from "../src/pi.ts";
import { SPEAKER_LIMITS, type Snapshot, speakerClient, speakerProxy, watchLeases as watch } from "../src/speaker.ts";

// speaker's own WebSocket library, typed from speaker's @types/ws.
type Ws = typeof import("../../speaker/node_modules/@types/ws/index.d.ts");
const { WebSocketServer } = createRequire(import.meta.url)("../../speaker/node_modules/ws") as Ws;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const port = (server: { address(): string | AddressInfo | null }) => (server.address() as AddressInfo).port;
const freePort = async () => {
  const probe = createNetServer().listen(0);
  await once(probe, "listening");
  const free = port(probe);
  probe.close();
  await once(probe, "close");
  return free;
};
// watchLeases reconnects until stopped, which would keep this process alive: stop each watcher when its test ends.
const watchLeases = (t: TestContext, ...args: Parameters<typeof watch>) => {
  const report = watch(...args);
  t.after(report.stop);
  return report;
};
const until = async (ok: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
  const start = Date.now();
  while (!(await ok())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await sleep(20);
  }
};

// A self-signed certificate for localhost: a local HTTPS upstream that speaker is made to trust like a public one.
const upstreamIdentity = await (async () => {
  const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=localhost",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3600_000),
    signingAlgorithm: algorithm,
    keys,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: "dns", value: "localhost" }])],
  });
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  return { cert: cert.toString("pem"), key: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n` };
})();
setDefaultCACertificates([...getCACertificates("default"), upstreamIdentity.cert]);

/** A real speaker in this process, its owner session, and an approved sandbox host. */
async function fixture(t: TestContext, { groups = {}, proxy = false }: { groups?: object; proxy?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "bottle-speaker-"));
  await writeFile(join(dataDir, "groups.json"), JSON.stringify(groups));
  const proxyPort = proxy ? await freePort() : undefined;
  const app = await createApp(
    readConfig({ DATA_DIR: dataDir, PUBLIC_URL: "http://localhost", ...(proxyPort ? { PROXY_PORT: String(proxyPort) } : {}) }),
  );
  // Closing an HTTP server also closes the WebSocket server it was given, so each listener gets its own.
  const sockets: InstanceType<Ws["WebSocketServer"]>[] = [];
  const listen = (listenPort: number) => {
    const wss = new WebSocketServer({ noServer: true });
    sockets.push(wss);
    return serve({ fetch: app.fetch, port: listenPort, hostname: "127.0.0.1", websocket: { server: wss } }) as Server;
  };
  const servers = [listen(0)];
  await once(servers[0], "listening");
  const speakerPort = port(servers[0]);
  t.after(async () => {
    for (const wss of sockets) for (const client of wss.clients) client.terminate();
    app.proxy?.closeAllConnections();
    app.proxy?.close();
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${speakerPort}`;
  const config = { speaker: { url, ...(proxyPort ? { proxyPort } : {}) }, shareRoots: {} } as Config;
  const owner = {
    cookie: await setOwnerPassword((path, init) => fetch(url + path, init)),
    origin: "http://localhost",
    "content-type": "application/json",
  };
  const ownerPost = (path: string, body: object = {}) =>
    fetch(`${url}/admin${path}`, { method: "POST", headers: owner, body: JSON.stringify(body), redirect: "manual" });
  const ownerForm = async (path: string, body: Record<string, string>) => {
    const response = await fetch(`${url}/admin${path}`, {
      method: "POST",
      headers: { cookie: owner.cookie, origin: owner.origin },
      body: new URLSearchParams(body),
      redirect: "manual",
    });
    assert.equal(response.status, 303, `${path} answered ${response.status}`);
  };
  // The owner's card posts the ticked items and the items it showed.
  const approve = async (id: string, items: string[]) => {
    const body = new URLSearchParams({ duration: "1h" });
    for (const item of items) {
      body.append("items", item);
      body.append("shown", item);
    }
    const response = await fetch(`${url}/admin/requests/${id}/approve`, {
      method: "POST",
      headers: { cookie: owner.cookie, origin: owner.origin },
      body,
      redirect: "manual",
    });
    assert.equal(response.status, 303, `approve answered ${response.status}`);
  };
  const live = async () =>
    (await (await fetch(`${url}/admin/live`, { headers: owner })).json()) as { grants: string; approvals: string };
  /** An approved sandbox host, its client, and one task agent. */
  const host = async (kinds: string[]) => {
    const token = "host-token";
    const created = await fetch(`${url}/_speaker/hosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bottle", kinds, tokenHash: sha(token) }),
    });
    const { id } = (await created.json()) as { id: string };
    await ownerPost(`/hosts/${id}/approve`);
    return { token, id, speaker: speakerClient(config, token) };
  };
  const dropConnections = () => {
    for (const wss of sockets) for (const client of wss.clients) client.terminate();
  };
  return { url, config, owner, ownerPost, ownerForm, approve, live, host, listen, servers, dropConnections };
}

test("watchLeases receives granted items as leases and reports applied ids to speaker", async (t) => {
  const f = await fixture(t);
  const { url, config, owner, ownerPost } = f;

  const token = "host-token";
  const created = await fetch(`${url}/_speaker/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bottle", kinds: ["site"], tokenHash: createHash("sha256").update(token).digest("hex") }),
  });
  const { id } = (await created.json()) as { id: string };
  const speaker = speakerClient(config, token);
  await assert.rejects(speaker.createAgent("pi", "Test LLM · Pi on test"), /401/);
  await ownerPost(`/hosts/${id}/approve`);

  // A token speaker doesn't know (data reset, other speaker) is fatal at once instead of a reconnect loop.
  const fatal: string[] = [];
  watchLeases(t, config, "unknown-token", () => {}, (message) => fatal.push(message));
  await until(() => fatal.length === 1);
  assert.match(fatal[0], /rejects this sandbox host's token \(HTTP 401\).*bottle-cli register/);

  const snapshots: Snapshot[] = [];
  const reportApplied = watchLeases(
    t,
    config,
    token,
    (snapshot) => snapshots.push(snapshot),
    (message) => assert.fail(`unexpected fatal speaker error: ${message}`),
  );
  const subject = await speaker.createAgent("pi", "Test LLM · Pi on test");
  const request = await speaker.request({
    agentId: subject.id,
    want: ["site:example.com"],
    reason: "docs",
    duration: "30m",
  });
  // The owner's card posts the ticked items and the items it showed.
  await fetch(`${url}/admin/requests/${request.id}/approve`, {
    method: "POST",
    headers: { cookie: owner.cookie, origin: owner.origin },
    body: new URLSearchParams({ duration: "1h", items: "site:example.com", shown: "site:example.com" }),
    redirect: "manual",
  });
  await until(() => snapshots.some((s) => s.leases.length === 1));
  const lease = snapshots.findLast((s) => s.leases.length)?.leases[0];
  assert.ok(lease);
  assert.deepEqual([lease.kind, lease.ref, lease.subjectId], ["site", "example.com", subject.id]);

  reportApplied([lease.id]);
  const active = async () => {
    const { grants } = (await (await fetch(`${url}/admin/live`, { headers: owner })).json()) as { grants: string };
    return grants.includes('<span class="sr">active</span>');
  };
  await until(active);
});

test("a template's want becomes the task's first request, labelled and timed as the template says", async (t) => {
  const f = await fixture(t, { groups: { pack: { description: "Package registries", items: ["site:pypi.org", "site:registry.npmjs.org"] } } });
  const { speaker } = await f.host(["site"]);
  const template = Template.parse({
    id: "packages",
    label: "Install PyPI and npm packages",
    limits: { cpus: 1, memoryMiB: 512, rootfsGiB: 1, workGiB: 1, maxRuntimeHours: 1 },
    want: ["group:pack", "site:example.com"],
    duration: "1d",
  });
  const agent = await speaker.createAgent(template.label, "Test LLM · Pi on test");
  const first = launchRequest(template, agent.id);
  assert.ok(first);
  const sent = await speaker.request(first);
  assert.equal(sent.status, "pending");
  const { approvals } = await f.live();
  assert.match(approvals, /Install PyPI and npm packages/);
  for (const item of ["site:pypi.org", "site:registry.npmjs.org", "site:example.com"]) assert.ok(approvals.includes(item), item);
  assert.match(approvals, /launch template packages: Install PyPI and npm packages/);
  // The template's duration is what the card preselects.
  assert.match(approvals, /<option value="1d" selected/);
});

test("bottle-school reports its shares to speaker as not mountable, since its folders arrive over SSH", async (t) => {
  const f = await fixture(t);
  const { token } = await f.host([]);
  const documents = await mkdtemp(join(tmpdir(), "bottle-share-"));
  t.after(() => rm(documents, { recursive: true, force: true }));
  const config = { ...f.config, shareRoots: { documents } } as Config;
  watchLeases(t, config, token, () => {}, (message) => assert.fail(message));
  await until(async () => (await f.live()).grants.includes("shares: documents (no VM mount)"));
});

test("without word from speaker for 30 seconds the grants are dropped until it is back", async (t) => {
  assert.equal(SPEAKER_LIMITS.dropMs, 30_000);
  const f = await fixture(t);
  const { token, speaker } = await f.host(["site"]);
  const received: Snapshot[] = [];
  const dropMs = 600;
  watchLeases(
    t,
    f.config,
    token,
    (snapshot) => received.push(snapshot),
    (message) => assert.fail(message),
    { ...SPEAKER_LIMITS, dropMs, retryMs: 100 },
  );
  const agent = await speaker.createAgent("pi", "Test LLM · Pi on test");
  const request = await speaker.request({ agentId: agent.id, want: ["site:example.com"], reason: "docs", duration: "30m" });
  await f.approve(request.id, ["site:example.com"]);
  await until(() => received.some((s) => s.leases.length === 1));

  // Speaker goes away. A short loss changes nothing; the grants are dropped once dropMs has passed.
  const lost = Date.now();
  const before = received.length;
  const [first] = f.servers;
  f.dropConnections();
  first.closeAllConnections();
  first.close();
  await sleep(dropMs / 3);
  assert.ok(received.slice(before).every((s) => s.leases.length), "grants must survive a short loss");
  await until(() => received.slice(before).some((s) => s.leases.length === 0));
  assert.ok(Date.now() - lost >= dropMs, `dropped after ${Date.now() - lost} ms, before the limit`);

  // Speaker returns: the next snapshot brings the grants back.
  f.servers.push(f.listen(Number(new URL(f.url).port)));
  await until(() => received.at(-1)?.leases.length === 1);
});

test("a grant counts as decided for the agent only once the sandbox host reports it in force", async (t) => {
  const f = await fixture(t);
  const { token, speaker } = await f.host(["site", "mcp"]);
  const snapshots: Snapshot[] = [];
  const reportApplied = watchLeases(t, f.config, token, (snapshot) => snapshots.push(snapshot), (message) => assert.fail(message));
  const agent = await speaker.createAgent("pi", "Test LLM · Pi on test");
  const ask = (want: string[]) =>
    fetch(`${f.url}/_speaker/requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json", "speaker-wait": "10" },
      body: JSON.stringify({ want, reason: "docs", duration: "30m" }),
    }).then((response) => response.json() as Promise<{ status: string; granted: string[]; applying?: string[]; next?: string }>);
  const me = async () =>
    (await (await fetch(`${f.url}/_speaker/me`, { headers: { authorization: `Bearer ${agent.token}` } })).json()) as {
      grants: { item: string; applying?: boolean }[];
    };

  // A site grant is waited for: the held call answers once the host has reported it, with the item granted.
  const site = ask(["site:example.com"]);
  await until(async () => (await f.live()).approvals.includes("site:example.com"));
  const requestId = (await f.live()).approvals.match(/id="request-([a-f0-9]+)"/)?.[1];
  assert.ok(requestId);
  await f.approve(requestId, ["site:example.com"]);
  await until(() => snapshots.some((s) => s.leases.some((lease) => lease.kind === "site")));
  await sleep(700); // the held call is polling, and nothing has been reported yet
  assert.deepEqual((await me()).grants.map((g) => [g.item, g.applying]), [["site:example.com", true]]);
  const lease = snapshots.findLast((s) => s.leases.length)?.leases[0];
  assert.ok(lease);
  reportApplied([lease.id]);
  const answered = await site;
  assert.deepEqual([answered.status, answered.granted, answered.applying], ["decided", ["site:example.com"], undefined]);
  assert.deepEqual((await me()).grants.map((g) => [g.item, g.applying]), [["site:example.com", undefined]]);

  // An MCP server only starts when Pi is idle, which a held call prevents: the call answers at once, and the item
  // is `applying` until the host reports it.
  const mcp = ask(["mcp:filesystem"]);
  await until(async () => (await f.live()).approvals.includes("mcp:filesystem"));
  const mcpId = (await f.live()).approvals.match(/id="request-([a-f0-9]+)"/)?.[1];
  assert.ok(mcpId);
  await f.approve(mcpId, ["mcp:filesystem"]);
  const decided = await mcp;
  assert.deepEqual([decided.status, decided.granted, decided.applying], ["decided", [], ["mcp:filesystem"]]);
  assert.match(decided.next ?? "", /sandbox is applying it/);
  await until(() => snapshots.some((s) => s.leases.some((l) => l.kind === "mcp")));
  const leases = snapshots.findLast((s) => s.leases.length === 2)?.leases ?? [];
  reportApplied(leases.map((l) => l.id));
  await until(async () => (await me()).grants.every((g) => !g.applying));
});

test("a secret grant reaches the sandbox as hosts only; its requests go through speaker's proxy, which inserts the value", async (t) => {
  const realToken = "ghp_real_token_only_the_upstream_should_see";
  const f = await fixture(t, { proxy: true });
  const seen: { url?: string; authorization?: string }[] = [];
  const upstream = createHttpsServer(upstreamIdentity, (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json").end('{"upstream":true}');
  }).listen(0);
  await once(upstream, "listening");
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  await f.ownerForm("/secrets/save", { name: "GITHUB_TOKEN", value: realToken, hosts: "localhost", env: "GH_TOKEN" });

  const { token, speaker } = await f.host(["secret"]);
  const wire: string[] = [];
  const snapshots: Snapshot[] = [];
  watchLeases(t, f.config, token, (snapshot) => snapshots.push(snapshot), (message) => assert.fail(message));
  const agent = await speaker.createAgent("pi", "Test LLM · Pi on test");
  const request = await speaker.request({ agentId: agent.id, want: ["secret:GITHUB_TOKEN"], reason: "open a pull request", duration: "30m" });
  await f.approve(request.id, ["secret:GITHUB_TOKEN"]);
  await until(() => snapshots.some((s) => s.leases.length === 1));
  const { leases, secrets } = snapshots.findLast((s) => s.leases.length)!;
  wire.push(JSON.stringify(snapshots));
  // The grant carries the hosts the owner bound the secret to; the snapshot also lists what a task may ask for.
  assert.deepEqual([leases[0].kind, leases[0].ref, leases[0].hosts], ["secret", "GITHUB_TOKEN", ["localhost"]]);
  assert.deepEqual(secrets, [{ name: "GITHUB_TOKEN", hosts: ["localhost"], env: "GH_TOKEN" }]);

  // What the agent is told: the variable to set to a placeholder, and no proxy settings (the sandbox route is built in).
  const me = (await (await fetch(`${f.url}/_speaker/me`, { headers: { authorization: `Bearer ${agent.token}` } })).json()) as {
    secrets: Record<string, { environment: Record<string, string>; hosts: string[] }>;
  };
  const placeholder = await speaker.placeholder(agent.token, "GITHUB_TOKEN");
  assert.match(placeholder, /^speaker-placeholder-[0-9a-f]{48}$/);
  assert.deepEqual(me.secrets.GITHUB_TOKEN.environment, { GH_TOKEN: placeholder });

  // The sandbox's route for the secret's hosts: speaker's proxy.
  const live = { secretHosts: [{ name: "GITHUB_TOKEN", hosts: leases[0].hosts!, expiresAt: leases[0].expiresAt }], events: [] };
  const route = secretRoute(live, () => speakerProxy(f.config, agent.token));
  t.after(() => route.close());
  assert.equal(await route.allow("localhost"), true);
  assert.equal(await route.allow("example.org"), undefined);
  assert.equal(route.dispatcher("example.org"), undefined);
  const call = () =>
    undiciFetch(`https://localhost:${port(upstream)}/repos/o/r/pulls`, {
      method: "POST",
      headers: { authorization: `token ${placeholder}` },
      body: "{}",
      dispatcher: route.dispatcher("localhost"),
    });
  const reply = await call();
  assert.deepEqual([reply.status, await reply.text()], [200, '{"upstream":true}']);
  assert.deepEqual(seen, [{ url: "/repos/o/r/pulls", authorization: `token ${realToken}` }]);

  // The real value is nowhere in bottle-school: not in its config, its process environment, what speaker sent it, the
  // task's live view, or the guest configuration it wrote.
  const guest = await mkdtemp(join(tmpdir(), "bottle-guest-"));
  t.after(() => rm(guest, { recursive: true, force: true }));
  writeGuestConfig(guest, { ...f.config, localModel: { guestHost: "model.internal", upstream: "127.0.0.1:1", models: [{ id: "m", label: "M" }] }, hostedProviders: [] } as Config, Catalog.parse({ mcps: {}, extensions: {} }), { name: "t", model: "local/m", attended: false }, new Map(), leases, [], [], secrets);
  const written = readdirSync(guest, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
  for (const haystack of [JSON.stringify(f.config), JSON.stringify(process.env), JSON.stringify(live), ...wire, ...written])
    assert.ok(!haystack.includes(realToken));

  // Revoked: the proxy refuses at once, and once the sandbox host drops the grant its route is gone too.
  const grantId = (await f.live()).grants.match(/<li id="grant-([^"]+)"/)?.[1];
  assert.ok(grantId);
  await f.ownerForm("/grants/revoke", { id: grantId });
  // Inside a kept-alive tunnel the proxy answers 403 with its message; a new tunnel is refused at CONNECT.
  const ended = await call().then(
    async (response) => ({ status: response.status, text: await response.text() }),
    (error: Error) => ({ status: 403, text: `${error.message} ${(error.cause as Error | undefined)?.message ?? ""}` }),
  );
  assert.equal(ended.status, 403);
  assert.match(ended.text, /403|access to localhost ended/);
  live.secretHosts = [];
  assert.equal(await route.allow("localhost"), undefined);
  assert.equal(route.dispatcher("localhost"), undefined);
  assert.equal(seen.length, 1);

  // A route that cannot be set up fails closed: no direct request, and the event says why.
  const broken = secretRoute({ secretHosts: live.secretHosts.concat([{ name: "X", hosts: ["localhost"], expiresAt: null }]), events: [] as { at: string; text: string }[] }, async () => {
    throw new Error("speaker.proxyPort is not set");
  });
  assert.equal(await broken.allow("localhost"), false);
  assert.throws(() => broken.dispatcher("localhost"), /refusing a direct request/);
});

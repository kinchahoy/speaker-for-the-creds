import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Client, type Dispatcher } from "undici";
import { egressDecision, egressProxy, folderPath, folderSync, listen, modelDoor, secretRoute, serveEgress, speakerDoor, type Live } from "../src/sandbox.ts";
import type { Config } from "../src/config.ts";

const live = (extra: Partial<Live> = {}): Live => ({
  hosts: [],
  secretHosts: [],
  shares: new Map(),
  events: [],
  modelRequests: 0,
  modelCapNoted: false,
  ...extra,
});
const speakerProxy = { close: async () => {} } as Dispatcher;
const root = mkdtempSync(join(tmpdir(), "pi-ms-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("egress proxy decision", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const state = () =>
    live({
      hosts: [
        { host: "pypi.org", expiresAt: future },
        { host: "*.example.com", expiresAt: future },
        { host: "old.example.org", expiresAt: new Date(Date.now() - 1).toISOString() },
        { host: "httpbin.org", expiresAt: future },
      ],
      secretHosts: [{ name: "TOKEN", hosts: ["httpbin.org"], expiresAt: future }],
    });

  test("allows listed hosts directly, sends secret hosts through speaker's proxy, and refuses the rest", async () => {
    const view = state();
    const route = secretRoute(view, speakerProxy);
    assert.equal(await egressDecision(view, route, "pypi.org"), "direct");
    assert.equal(await egressDecision(view, route, "api.example.com"), "direct");
    assert.equal(await egressDecision(view, route, "httpbin.org"), "speaker");
    assert.equal(await egressDecision(view, route, "evil.test"), "refuse");
    assert.equal(await egressDecision(view, route, "old.example.org"), "refuse");
    assert.equal(await egressDecision(view, route, "10.0.0.5"), "refuse");
    assert.match(view.events.at(-1)!.text, /blocked a request to 10\.0\.0\.5/);
    for (const ip of ["::1", "fc00::1", "::ffff:192.168.1.5", "2606:4700:4700::1111"]) assert.equal(await egressDecision(view, route, ip), "refuse", ip);
  });

  test("a grant change applies to the next request", async () => {
    const view = state();
    const route = secretRoute(view, speakerProxy);
    assert.equal(await egressDecision(view, route, "new.test"), "refuse");
    view.hosts.push({ host: "new.test", expiresAt: null });
    assert.equal(await egressDecision(view, route, "new.test"), "direct");
  });

  test("the proxy answers a refused host with 403", async () => {
    const view = state();
    const proxy = egressProxy(view, secretRoute(view, speakerProxy), { proxy: "127.0.0.1:1", agentToken: "t" });
    const socket = join(root, "egress.sock");
    const server = await serveEgress(proxy, socket);
    const client = connect(socket);
    client.write("GET http://evil.test/ HTTP/1.1\r\nHost: evil.test\r\n\r\n");
    const [reply] = await once(client, "data");
    assert.match(String(reply), /^HTTP\/1\.1 403 /);
    assert.match(String(reply), /evil\.test is not approved for this task\. To get access, call request_capability with site:evil\.test\./);
    client.destroy();
    server.close();
  });

  test("revoking a grant closes a tunnel already open to that host", async () => {
    // Stands in for speaker's proxy: accepts the CONNECT and then holds the tunnel open.
    const upstream = createNetServer((socket) => socket.once("data", () => socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const { port } = upstream.address() as { port: number };
    const view = live({ secretHosts: [{ name: "TOKEN", hosts: ["api.test"], expiresAt: new Date(Date.now() + 60_000).toISOString() }] });
    const proxy = egressProxy(view, secretRoute(view, speakerProxy), { proxy: `127.0.0.1:${port}`, agentToken: "t" });
    const server = await serveEgress(proxy, join(root, "tunnel.sock"));
    const client = connect(join(root, "tunnel.sock"));
    client.write("CONNECT api.test:443 HTTP/1.1\r\nHost: api.test:443\r\n\r\n");
    assert.match(String((await once(client, "data"))[0]), /^HTTP\/1\.1 200 /);
    proxy.sweep();
    assert.equal(client.destroyed, false, "a granted host's tunnel stays open");
    view.secretHosts = [];
    proxy.sweep();
    await once(client, "close");
    assert.ok(view.events.some((event) => event.text === "closed a connection to api.test: its grant ended"));
    server.close();
    upstream.close();
  });
});

describe("model endpoint", () => {
  test("counts every request against the cap, answers the next with 429, and records bodies", async () => {
    const upstream = createServer((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end('{"choices":[]}'));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const { port } = upstream.address() as { port: number };
    const config = { hostedProviders: [], localModel: { upstream: `127.0.0.1:${port}`, guestHost: "model.internal" } } as unknown as Config;
    const view = live({ maxModelRequests: 2 });
    const modelCalls = join(root, "model-calls.jsonl");
    const socket = join(root, "model.sock");
    const door = await listen(socket, modelDoor(config, view, { url: "http://127.0.0.1:1", agentToken: "t" }, modelCalls));
    const client = new Client("http://model.internal", { socketPath: socket });
    const ask = async () => {
      const response = await client.request({
        method: "POST",
        path: "/v1/chat/completions",
        body: '{"model":"m"}',
        headers: { "content-type": "application/json" },
      });
      return { status: response.statusCode, body: await response.body.text() };
    };
    assert.deepEqual(await ask(), { status: 200, body: '{"choices":[]}' });
    assert.equal((await ask()).status, 200);
    const refused = await ask();
    assert.equal(refused.status, 429);
    // The model door keeps the OpenAI error shape Pi's model client reads.
    assert.deepEqual(JSON.parse(refused.body), { error: { message: "model request limit 2 reached; the owner can raise it" } });
    assert.equal(view.modelRequests, 2);
    const calls = readFileSync(modelCalls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.deepEqual([calls[0].status, calls[0].request, calls[0].reply, calls[0].truncated], [200, '{"model":"m"}', '{"choices":[]}', false]);
    await client.close();
    door.close();
    upstream.close();
  });
});

describe("folders over SSH", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  /** A guest whose mount table is a map, recording what the sync asked of it. */
  const fakeGuest = (fail = false) => {
    const table = new Map<string, boolean>();
    const calls: string[] = [];
    return {
      table,
      calls,
      mounted: async () => new Map(table),
      mount: async (share: string, writable: boolean) => {
        calls.push(`mount ${share} ${writable ? "rw" : "ro"}`);
        if (fail) throw new Error("no key yet");
        table.set(share, writable);
      },
      unmount: async (share: string, writable: boolean) => {
        calls.push(`unmount ${share} ${folderPath(share, writable)}`);
        table.delete(share);
      },
    };
  };

  test("mounts a grant, remounts a changed mode, unmounts an ended grant, and remounts a mount that vanished", async () => {
    const view = live();
    const guest = fakeGuest();
    const sync = folderSync(view, guest);
    await sync();
    assert.deepEqual(guest.calls, []);
    view.shares.set("docs", { writable: false, expiresAt: future });
    await sync();
    view.shares.set("docs", { writable: true, expiresAt: future });
    await sync();
    guest.table.delete("docs"); // speaker ended the session
    await sync();
    view.shares.set("docs", { writable: true, expiresAt: new Date(Date.now() - 1).toISOString() });
    await sync();
    assert.deepEqual(guest.calls, ["mount docs ro", "unmount docs /input/docs", "mount docs rw", "mount docs rw", "unmount docs /space/docs"]);
    assert.equal(guest.table.size, 0);
  });

  test("read-only shares mount under /input, read-write ones under /space", () => {
    assert.deepEqual([folderPath("docs", false), folderPath("docs", true)], ["/input/docs", "/space/docs"]);
  });

  test("notes a failed mount once and retries it", async () => {
    const view = live();
    view.shares.set("docs", { writable: false, expiresAt: future });
    const guest = fakeGuest(true);
    const sync = folderSync(view, guest, 0);
    await sync();
    await sync();
    assert.equal(guest.calls.length, 2);
    assert.deepEqual(
      view.events.map((event) => event.text),
      ["could not mount folder docs: no key yet"],
    );
  });

  test("the guest's requests to speaker carry the agent's SSH key, and nothing else is touched", async () => {
    const seen: { method?: string; url?: string; body: string }[] = [];
    const speaker = createServer((req, res) => {
      let body = "";
      req
        .on("data", (chunk) => (body += chunk))
        .on("end", () => {
          seen.push({ method: req.method, url: req.url, body });
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
        });
    });
    await new Promise<void>((resolve) => speaker.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(speaker.address() as { port: number }).port}`;
    const socket = join(root, "speaker.sock");
    const door = await listen(socket, speakerDoor({ url, agentToken: "t" }, "ssh-ed25519 AAAA", []));
    const client = new Client("http://speaker.internal", { socketPath: socket });
    await (
      await client.request({ method: "POST", path: "/_speaker/requests", body: '{"want":["folder:docs"]}', headers: { "content-type": "application/json" } })
    ).body.dump();
    await (await client.request({ method: "GET", path: "/_speaker/catalog" })).body.dump();
    assert.deepEqual(JSON.parse(seen[0]!.body), { want: ["folder:docs"], sshKey: "ssh-ed25519 AAAA" });
    assert.deepEqual([seen[1]!.method, seen[1]!.body], ["GET", ""]);
    // Every other door refuses in speaker's error shape.
    const refused = await client.request({ method: "GET", path: "/admin" });
    assert.equal(refused.statusCode, 403);
    assert.deepEqual(await refused.body.json(), { error: "denied", message: "this speaker path is not available to a sandboxed task" });
    await client.close();
    door.close();
    speaker.close();
  });
});

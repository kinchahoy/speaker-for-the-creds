import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Client, type Dispatcher } from "undici";
import { egressDecision, egressProxy, folderSync, listen, modelDoor, secretRoute, serveEgress, speakerDoor, type Live } from "../src/sandbox.ts";
import type { Config } from "../src/config.ts";

const live = (extra: Partial<Live> = {}): Live => ({
  hosts: [],
  secretHosts: [],
  shares: new Map(),
  events: [],
  httpResponses: [],
  httpResponsesOmitted: 0,
  httpBodyBytes: 0,
  modelRequests: 0,
  modelCapNoted: false,
  ...extra,
});
const speakerProxy = (): Promise<Dispatcher> => Promise.resolve({ close: async () => {} } as Dispatcher);
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
  });

  test("a lease change applies to the next request, and a secret host is never sent direct when speaker's proxy is down", async () => {
    const view = state();
    const route = secretRoute(view, () => Promise.reject(new Error("no PROXY_PORT")));
    assert.equal(await egressDecision(view, route, "new.test"), "refuse");
    view.hosts.push({ host: "new.test", expiresAt: null });
    assert.equal(await egressDecision(view, route, "new.test"), "direct");
    assert.equal(await egressDecision(view, route, "httpbin.org"), "refuse");
    assert.match(view.events.at(-1)!.text, /blocked a request to httpbin\.org: no PROXY_PORT/);
  });

  test("the proxy answers a refused host with 403", async () => {
    const view = state();
    const proxy = egressProxy(view, secretRoute(view, speakerProxy), { token: "t" });
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
    const captures = join(root, "blobs");
    mkdirSync(captures);
    const socket = join(root, "model.sock");
    const door = await listen(socket, modelDoor(config, view, secretRoute(view, speakerProxy), captures));
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
    assert.match(refused.body, /model request limit 2 reached/);
    assert.equal(view.modelRequests, 2);
    assert.equal(view.httpResponses.length, 2);
    assert.equal(view.httpResponses[0]!.destination, `http://127.0.0.1:${port}`);
    assert.equal(view.httpResponses[0]!.requestCapture, "complete");
    assert.equal(view.httpResponses[0]!.responseCapture, "complete");
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
      unmount: async (share: string) => {
        calls.push(`unmount ${share}`);
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
    assert.deepEqual(guest.calls, ["mount docs ro", "unmount docs", "mount docs rw", "mount docs rw", "unmount docs"]);
    assert.equal(guest.table.size, 0);
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

  test("the guest's requests to speaker carry the task's SSH key, and nothing else is touched", async () => {
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
    const door = await listen(socket, speakerDoor({ url, token: "t" }, "ssh-ed25519 AAAA"));
    const client = new Client("http://speaker.internal", { socketPath: socket });
    await (
      await client.request({ method: "POST", path: "/_speaker/requests", body: '{"want":["folder:docs"]}', headers: { "content-type": "application/json" } })
    ).body.dump();
    await (await client.request({ method: "GET", path: "/_speaker/catalog" })).body.dump();
    assert.deepEqual(JSON.parse(seen[0]!.body), { want: ["folder:docs"], sshKey: "ssh-ed25519 AAAA" });
    assert.deepEqual([seen[1]!.method, seen[1]!.body], ["GET", ""]);
    await client.close();
    door.close();
    speaker.close();
  });
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Client, type Dispatcher } from "undici";
import { secretRoute, type Live } from "../src/backend.ts";
import { egressDecision, egressProxy, serveEgress, listen, modelDoor } from "../src/backends/microsandbox.ts";
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
      const response = await client.request({ method: "POST", path: "/v1/chat/completions", body: '{"model":"m"}', headers: { "content-type": "application/json" } });
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

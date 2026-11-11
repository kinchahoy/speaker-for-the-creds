import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "../../speaker/node_modules/@hono/node-server/dist/index.mjs";
import { createApp, readConfig, wss } from "../../speaker/server.ts";
import type { Config } from "../src/config.ts";
import { type Snapshot, speakerClient, watchLeases } from "../src/speaker.ts";

test("watchLeases receives approved leases and reports applied ids to speaker", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "bottle-speaker-"));
  const app = await createApp(readConfig({ ADMIN_PASSWORD: "pw", DATA_DIR: dataDir, PUBLIC_URL: "http://localhost" }));
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: wss } }) as Server;
  await once(server, "listening");
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections();
    server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  // watchLeases retries on timers; unref them so the test process can exit.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => realSetTimeout(...args).unref()) as typeof setTimeout;
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = { speaker: { url } } as Config;
  const owner = {
    authorization: `Basic ${Buffer.from("admin:pw").toString("base64")}`,
    origin: "http://localhost",
    "content-type": "application/json",
  };
  const ownerPost = (path: string, body: object = {}) =>
    fetch(`${url}/admin${path}`, { method: "POST", headers: owner, body: JSON.stringify(body), redirect: "manual" });
  const until = async (ok: () => boolean | Promise<boolean>) => {
    while (!(await ok())) await sleep(50);
  };

  const token = "enforcer-token";
  const created = await fetch(`${url}/_speaker/enforcers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bottle", kinds: ["site"], tokenHash: createHash("sha256").update(token).digest("hex") }),
  });
  const { id } = (await created.json()) as { id: string };
  const speaker = speakerClient(config, token);
  await assert.rejects(speaker.createSubject("pi"), /401/);
  await ownerPost(`/enforcers/${id}/approve`);

  // A token speaker doesn't know (data reset, other speaker) is fatal at once instead of a reconnect loop.
  const fatal: string[] = [];
  watchLeases(config, "unknown-token", () => {}, (message) => fatal.push(message));
  await until(() => fatal.length === 1);
  assert.match(fatal[0], /rejects this host's enforcer token \(HTTP 401\).*bottle-cli register/);

  const snapshots: Snapshot[] = [];
  const reportApplied = watchLeases(
    config,
    token,
    (snapshot) => snapshots.push(snapshot),
    (message) => assert.fail(`unexpected fatal speaker error: ${message}`),
  );
  const subject = await speaker.createSubject("pi");
  const request = await speaker.request({
    subjectId: subject.id,
    capability: { kind: "site", ref: "example.com" },
    reason: "docs",
    duration: "15m",
  });
  await ownerPost(`/api/requests/${request.id}/approve`, { duration: "1h" });
  await until(() => snapshots.some((s) => s.leases.length === 1));
  const lease = snapshots.findLast((s) => s.leases.length)?.leases[0];
  assert.ok(lease);
  assert.deepEqual([lease.kind, lease.ref, lease.subjectId], ["site", "example.com", subject.id]);

  reportApplied([lease.id]);
  const state = async () =>
    ((await (await fetch(`${url}/admin/api/leases`, { headers: owner })).json()) as { state: string }[])[0]?.state;
  await until(async () => (await state()) === "active");
});

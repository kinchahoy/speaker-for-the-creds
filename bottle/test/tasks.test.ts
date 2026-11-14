import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "../../speaker/node_modules/@hono/node-server/dist/index.mjs";
import { createApp, readConfig } from "../../speaker/server.ts";
import { setOwnerPassword } from "../../speaker/test/owner.ts";
import type { Config } from "../src/config.ts";
import { Template } from "../src/grants.ts";
import { Catalog } from "../src/pi.ts";
import type { Boot, Guest } from "../src/sandbox.ts";
import { Tasks } from "../src/tasks.ts";

type Ws = typeof import("../../speaker/node_modules/@types/ws/index.d.ts");
const { WebSocketServer } = createRequire(import.meta.url)("../../speaker/node_modules/ws") as Ws;
const until = async (ok: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
  const start = Date.now();
  while (!(await ok())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await sleep(20);
  }
};
const limits = { cpus: 1, memoryMiB: 512, rootfsGiB: 1, workGiB: 1, maxRuntimeHours: 1 };

/**
 * A real speaker with an approved sandbox host, and Tasks over a stand-in VM: every guest command is recorded and
 * succeeds, and Pi reports "not running" so a close needs no grace period.
 */
async function fixture(t: TestContext, catalog: unknown = { mcps: {}, extensions: {} }) {
  const root = await mkdtemp(join(tmpdir(), "bottle-tasks-"));
  const dirs = { configRoot: join(root, "config"), stateRoot: join(root, "state"), outputRoot: join(root, "output") };
  for (const dir of Object.values(dirs)) await mkdir(dir);
  const app = await createApp(readConfig({ DATA_DIR: join(root, "speaker"), PUBLIC_URL: "http://localhost" }));
  const wss = new WebSocketServer({ noServer: true });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: wss } }) as Server;
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = { cookie: await setOwnerPassword((path, init) => fetch(url + path, init)), origin: "http://localhost" };
  const ownerPost = (path: string, body: URLSearchParams = new URLSearchParams()) =>
    fetch(`${url}/admin${path}`, { method: "POST", headers: owner, body, redirect: "manual" });
  const panel = async (name: "inbox" | "active") => (await fetch(`${url}/admin/panel/${name}`, { headers: owner })).text();

  const hostToken = "tasks-host-token";
  const registered = await fetch(`${url}/_speaker/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "bottle",
      kinds: ["site", "secret", "folder", "mcp", "ext"],
      tokenHash: createHash("sha256").update(hostToken).digest("hex"),
    }),
  });
  await ownerPost(`/hosts/${((await registered.json()) as { id: string }).id}/approve`);

  const config = {
    ...dirs,
    bindHost: "127.0.0.1",
    controlPort: 1,
    guestPort: 2,
    maxTasks: 2,
    guestImage: "test",
    speaker: { url },
    shareRoots: {},
    localModel: { guestHost: "model.internal", upstream: "127.0.0.1:1", models: [{ id: "m", label: "M" }] },
    hostedProviders: [],
  } satisfies Config;
  const templates = new Map(
    [
      { id: "offline", label: "Work offline", limits },
      { id: "web", label: "Read example.com", limits, want: ["site:example.com"], duration: "1h" },
    ].map((entry) => [entry.id, Template.parse(entry)]),
  );
  const commands: string[] = [];
  let closed = 0;
  let restartFails = false;
  const boot: Boot = async (_config, _live, _limits, paths) => {
    // Pi's session as the guest would have written it, for the archive.
    await mkdir(`${paths.work}/.pi-session`, { recursive: true });
    await writeFile(`${paths.work}/.pi-session/task.jsonl`, `${JSON.stringify({ type: "session", id: "s1" })}\n`);
    return {
      sessionId: "bottle-test",
      exec: async (command) => {
        commands.push(command);
        // Pi reports "not running", and a restart (which starts with pkill) fails when the test says so.
        return { exitCode: command.startsWith("ps -C pi") || (restartFails && command.startsWith("pkill -x pi;")) ? 1 : 0, stdout: "", stderr: "" };
      },
      close: async () => void closed++,
    } satisfies Guest;
  };
  const tasks = new Tasks(config, templates, Catalog.parse(catalog), hostToken, boot);
  t.after(async () => {
    tasks.stop();
    for (const client of wss.clients) client.terminate();
    await app.stop();
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { url, tasks, commands, closed: () => closed, failRestarts: () => (restartFails = true), ownerPost, panel, config };
}

test("a launch boots the VM, starts Pi, writes its configuration and files the template's first request", async (t) => {
  const f = await fixture(t);
  const task = await f.tasks.create({ template: "web", name: "docs" });
  assert.equal(task.state, "idle");
  assert.equal(task.attended, true);
  assert.ok(f.commands.includes("dtach -n /run/pi.dtach /usr/local/bin/pi-launch"), "Pi started");
  assert.match(readFileSync(`${task.guestConfigDir}/args`, "utf8"), /--model\nm\n/);
  assert.match(readFileSync(`${task.guestConfigDir}/APPEND_SYSTEM.md`, "utf8"), /# Task: docs/);
  const inbox = await f.panel("inbox");
  assert.match(inbox, /<strong>docs<\/strong>/);
  assert.match(inbox, /launch template web: Read example\.com/);
  assert.ok(inbox.includes('value="site:example.com"'));
  // The task waits for the owner: the request shows as pending in its listing.
  await until(() => f.tasks.pendingRequests(task).length === 1);
  assert.equal(f.tasks.pendingRequests(task)[0]!.what, "site:example.com");
  // Without a template want, nothing is asked at launch.
  await f.tasks.create({ template: "offline" });
  assert.equal((await f.panel("inbox")).match(/<article id="request-/g)?.length, 1);
});

test("an approved grant reaches the task's live view and is reported to speaker as in force", async (t) => {
  const f = await fixture(t);
  const task = await f.tasks.create({ template: "web" });
  await until(() => f.tasks.pendingRequests(task).length === 1);
  const [request] = f.tasks.pendingRequests(task);
  const body = new URLSearchParams({ duration: "1h", items: "site:example.com", shown: "site:example.com" });
  assert.equal((await f.ownerPost(`/requests/${request!.id}/approve`, body)).status, 303);
  await until(() => task.live.hosts.some((entry) => entry.host === "example.com"));
  assert.deepEqual(
    task.grants.map((grant) => grant.item),
    ["site:example.com"],
  );
  assert.match(readFileSync(`${task.outputDir}/_control/grants.jsonl`, "utf8"), /"item":"site:example.com"/);
  assert.ok(task.events.some((event) => event.text === "grants now: site:example.com"));
  // Speaker hears it applied: the grant is no longer marked as waiting or granted-not-applied.
  await until(async () => {
    const active = await f.panel("active");
    return active.includes("<code>site:example.com</code>") && !active.includes("data-state=");
  });
});

test("stop asks Pi to quit, exports the transcript, archives the records, closes the VM and ends the speaker agent", async (t) => {
  const f = await fixture(t);
  const task = await f.tasks.create({ template: "offline", name: "archive me", prompt: "write DONE" });
  assert.equal(task.attended, false);
  await writeFile(`${task.outputDir}/artifacts/result.txt`, "result\n");
  await f.tasks.close(task);
  assert.equal(task.state, "archived");
  assert.equal(f.closed(), 1);
  assert.equal(f.tasks.byId.has(task.id), false);
  assert.ok(f.commands.includes("printf '/quit\\r' | dtach -p /run/pi.dtach"), "Pi asked to quit");
  assert.ok(f.commands.some((command) => command.startsWith("pi --export /work/.pi-session/task.jsonl")));
  const control = `${task.outputDir}/_control`;
  const record = JSON.parse(readFileSync(`${control}/task.json`, "utf8"));
  assert.deepEqual([record.id, record.state, record.name, record.attended], [task.id, "archived", "archive me", false]);
  const manifest = JSON.parse(readFileSync(`${control}/manifest.json`, "utf8"));
  assert.equal(manifest.closed, true);
  assert.deepEqual(
    manifest.files.map((file: { path: string }) => file.path),
    ["result.txt"],
  );
  const trace = readFileSync(`${control}/trace.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    trace.map((run) => run.name),
    ["archive me", "pi"],
  );
  assert.ok(existsSync(`${control}/pi-session.jsonl`));
  assert.match(readFileSync(`${control}/policy-events.jsonl`, "utf8"), /owner began archival/);
  assert.equal(existsSync(`${f.config.stateRoot}/tasks/${task.id}`), false, "the work tree is removed");
  assert.equal(existsSync(`${control}/blobs`), false);
  // The task's agent is gone from speaker.
  const response = await fetch(`${f.url}/_speaker/catalog`, { headers: { authorization: `Bearer ${task.agentToken}` } });
  assert.equal(response.status, 403);
});

test("a task whose Pi restart failed is pi-down, and closing it still exports the transcript", async (t) => {
  const catalog = {
    mcps: {},
    extensions: { notes: { label: "Notes", guestPath: "/opt/notes", description: "Take notes", tools: ["note"], sites: [] } },
  };
  const f = await fixture(t, catalog);
  const task = await f.tasks.create({ template: "offline", name: "restarts" });
  f.failRestarts();
  await f.tasks.speaker.request({ agentId: task.agentId, want: ["ext:notes"], reason: "take notes", duration: "1h" });
  await until(() => f.tasks.pendingRequests(task).length === 1);
  const [request] = f.tasks.pendingRequests(task);
  const body = new URLSearchParams({ duration: "1h", items: "ext:notes", shown: "ext:notes" });
  assert.equal((await f.ownerPost(`/requests/${request!.id}/approve`, body)).status, 303);
  await until(() => task.state === "pi-down");
  f.commands.length = 0;
  await f.tasks.close(task);
  assert.equal(task.state, "archived");
  assert.ok(f.commands.includes("printf '/quit\\r' | dtach -p /run/pi.dtach"), "Pi asked to quit");
  assert.ok(
    f.commands.some((command) => command.startsWith("pi --export /work/.pi-session/task.jsonl")),
    "transcript exported",
  );
  assert.ok(existsSync(`${task.outputDir}/_control/pi-session.jsonl`));
});

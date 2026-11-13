import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.ts";

const init = join(import.meta.dirname, "..", "..", "init.ts");
const lan = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry?.family === "IPv4" && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))?.address;
const kvm = (() => {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
})();

const listen = async (t: TestContext, host: string, handler: Parameters<typeof createServer>[1]) => {
  const server: Server = createServer(handler).listen(0, host);
  t.after(() => void server.close());
  await new Promise((done) => server.once("listening", done));
  return (server.address() as AddressInfo).port;
};

// The real home filesystem: /tmp can be a small RAM disk, and init wants 20 GiB free.
const scratch = (t: TestContext) => {
  mkdirSync(join(homedir(), ".cache"), { recursive: true });
  const dir = mkdtempSync(join(homedir(), ".cache", "bi-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// Asynchronous: the fake speaker and model servers live in this process and must keep answering.
const run = async (args: string[], home: string) => {
  const flags = [init, "bottle-school", "--yes", "--skip-build", "--skip-register", "--skip-smoke", ...args];
  return promisify(execFile)(process.execPath, flags, { env: { ...process.env, BOTTLE_SCHOOL_HOME: home, BOTTLE_SCHOOL_CONFIG: "", MSB_HOME: "" } }).then(
    (done) => ({ status: 0, ...done }),
    (failed: { code: number; stdout: string; stderr: string }) => ({ status: failed.code, stdout: failed.stdout, stderr: failed.stderr }),
  );
};

test("init bottle-school writes a config.json that loads, with private directories and the chosen model", { skip: !kvm || !lan }, async (t) => {
  const dir = scratch(t);
  const speaker = await listen(t, "0.0.0.0", (_request, response) => response.end('{"ok":true}'));
  const model = await listen(t, "127.0.0.1", (_request, response) => response.end(JSON.stringify({ data: [{ id: "small" }, { id: "big" }] })));
  const configPath = join(dir, "h", "config.json");
  const result = await run(
    [
      "--image",
      "pi-init-unit",
      ...["--control-port", "7391", "--guest-port", "7392", "--speaker-url", `http://${lan}:${speaker}`],
      ...["--model-endpoint", `127.0.0.1:${model}`, "--model", "big"],
    ],
    join(dir, "h"),
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const config = loadConfig(configPath);
  assert.equal(config.guestImage, "pi-init-unit");
  assert.deepEqual([config.controlPort, config.guestPort], [7391, 7392]);
  assert.equal(config.speaker.url, `http://${lan}:${speaker}`);
  assert.equal(config.localModel.upstream, `127.0.0.1:${model}`);
  assert.deepEqual(config.localModel.models, [{ id: "big", label: "big" }]);
  for (const directory of [config.configRoot, config.stateRoot, config.outputRoot, join(dir, "h")])
    assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
  assert.ok(existsSync(join(config.configRoot, "templates.json")) && existsSync(join(config.configRoot, "catalog.json")));
  assert.match(readFileSync(configPath, "utf8"), /\n$/);
});

test("init bottle-school refuses a loopback speaker URL, which a VM cannot reach, and writes no config", { skip: !kvm }, async (t) => {
  const dir = scratch(t);
  const result = await run(["--speaker-url", "http://127.0.0.1:3000", "--model-endpoint", "127.0.0.1:1"], join(dir, "h"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /A VM cannot reach a loopback address/);
  assert.equal(existsSync(join(dir, "h", "config.json")), false);
});

test("init bottle-school --yes refuses to replace an existing setup unless --force", { skip: !kvm }, async (t) => {
  const home = join(scratch(t), "h");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), "{}");
  const result = await run([], home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already set up .*config\.json.*pass --force/);
});

test("init bottle-school refuses a home too long for microsandbox's unix sockets", async (t) => {
  const home = join(scratch(t), "x".repeat(60));
  const result = await run([], home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /too long a path .*BOTTLE_SCHOOL_HOME/);
  assert.equal(existsSync(home), false);
});

// A speaker that is locked until /admin/signin gets the owner password. A registered host stays pending (401 on
// /_speaker/catalog) until the signed-in owner posts the approval, as the admin page does.
const lockedSpeaker = async (t: TestContext, owner: string) => {
  let unlocked = false;
  let approved = false;
  const port = await listen(t, "0.0.0.0", (request, response) => {
    const url = request.url ?? "";
    if (request.method === "POST" && url === "/admin/signin") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        unlocked ||= new URLSearchParams(body).get("password") === owner;
        response.writeHead(unlocked ? 303 : 401, { location: "/admin", "set-cookie": "speaker_session=s1; HttpOnly; Path=/admin" }).end();
      });
    } else if (request.method === "POST" && url === "/admin/hosts/h1/approve") {
      const signedIn = request.headers.cookie === "speaker_session=s1" && request.headers.origin === `http://${request.headers.host}`;
      approved ||= signedIn;
      response.writeHead(signedIn ? 303 : 401).end();
    } else if (url === "/_speaker/catalog" && request.headers.authorization && !approved) response.writeHead(401).end("{}");
    else if (!unlocked && url.startsWith("/_speaker/") && !url.endsWith("/health")) response.writeHead(503).end("{}");
    else if (request.method === "POST" && url === "/_speaker/hosts") response.writeHead(201).end('{"id":"h1"}');
    else response.end('{"ok":true}');
  });
  return { port, unlocked: () => unlocked, approved: () => approved };
};

const registering = async (t: TestContext, owner: string, typed: string) => {
  const dir = scratch(t);
  const speaker = await lockedSpeaker(t, owner);
  const model = await listen(t, "127.0.0.1", (_request, response) => response.end(JSON.stringify({ data: [{ id: "small" }] })));
  const args = [init, "bottle-school", "--yes", "--skip-build", "--skip-smoke", "--password-stdin"];
  args.push("--control-port", "7401", "--guest-port", "7402", "--speaker-url", `http://${lan}:${speaker.port}`, "--model-endpoint", `127.0.0.1:${model}`);
  const child = execFile(process.execPath, args, { env: { ...process.env, BOTTLE_SCHOOL_HOME: join(dir, "h"), BOTTLE_SCHOOL_CONFIG: "", MSB_HOME: "" } });
  child.stdin?.end(`${typed}\n`);
  const status = await new Promise<number | null>((done) => child.once("exit", done));
  return { status, speaker };
};

test("init bottle-school unlocks a locked speaker with the password from --password-stdin", { skip: !kvm || !lan }, async (t) => {
  const { status, speaker } = await registering(t, "the owner password", "the owner password");
  assert.equal(status, 0);
  assert.equal(speaker.unlocked(), true);
  assert.equal(speaker.approved(), true, "init approved its own sandbox host without waiting");
});

test("init bottle-school stops when --password-stdin carries the wrong password", { skip: !kvm || !lan }, async (t) => {
  const { status, speaker } = await registering(t, "the owner password", "not it");
  assert.equal(status, 1);
  assert.equal(speaker.unlocked(), false);
});

// The CLI reads the control API of a bottle-school that is not running: a fake that serves no live tasks.
test("bottle-school:cli run names the archive folder, and ls lists finished tasks with their archive folders", { skip: !kvm || !lan }, async (t) => {
  const dir = scratch(t);
  const speaker = await listen(t, "0.0.0.0", (_request, response) => response.end('{"ok":true}'));
  const model = await listen(t, "127.0.0.1", (_request, response) => response.end(JSON.stringify({ data: [{ id: "small" }] })));
  const configPath = join(dir, "h", "config.json");
  const made = await run(
    [...["--control-port", "7411", "--guest-port", "7412", "--speaker-url", `http://${lan}:${speaker}`], ...["--model-endpoint", `127.0.0.1:${model}`]],
    join(dir, "h"),
  );
  assert.equal(made.status, 0, made.stderr + made.stdout);
  const { outputRoot } = loadConfig(configPath);
  const folder = join(outputRoot, "2026-01-01_0000--demo--abc123");
  mkdirSync(join(folder, "_control"), { recursive: true });
  writeFileSync(join(folder, "_control", "task.json"), JSON.stringify({ id: "abc123", state: "archived" }));
  mkdirSync(join(outputRoot, "2026-01-02_0000--live--def456"), { recursive: true }); // a live task has no task.json yet

  const control = createServer((request, response) =>
    response.end(request.method === "POST" ? JSON.stringify({ id: "new1", outputDir: join(outputRoot, "stamp--new--new1") }) : '{"tasks":[]}'),
  ).listen(7411, "127.0.0.1");
  t.after(() => void control.close());
  await new Promise((done) => control.once("listening", done));
  const cli = async (...args: string[]) =>
    (
      await promisify(execFile)(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), ...args], {
        env: { ...process.env, BOTTLE_SCHOOL_CONFIG: configPath },
      })
    ).stdout;

  assert.match(await cli("run", "--prompt", "x"), new RegExp(`The archive will be written to ${join(outputRoot, "stamp--new--new1")}`));
  const listing = await cli("ls");
  assert.match(listing, new RegExp(`archived\\s+${folder}`));
  assert.doesNotMatch(listing, /def456/);
});

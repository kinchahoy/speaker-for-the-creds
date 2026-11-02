import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { Catalog, writeGuestConfig } from "../src/pi.ts";
import { loadConfig } from "../src/config.ts";
import { folderRef, ipv4Destination, loadTemplates, secretRef, speakerRequestAllowed } from "../src/leases.ts";
import { assembleStream, createModelRuns, createToolRuns } from "../src/trace-runs.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const writeConfig = (bindHost = "127.0.0.1", controlPort = 7001) => {
  const root = mkdtempSync(join(tmpdir(), "pi-v2-config-"));
  roots.push(root);
  for (const name of ["config", "state", "output", "documents"]) mkdirSync(join(root, name));
  const path = join(root, "config.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        bindHost,
        controlPort,
        guestPort: 7002,
        speaker: { url: "http://127.0.0.1:7000" },
        maxTasks: 1,
        guestImage: "pi-v2-guest",
        configRoot: join(root, "config"),
        stateRoot: join(root, "state"),
        outputRoot: join(root, "output"),
        shareRoots: { documents: join(root, "documents") },
        localModel: {
          guestHost: "model.internal",
          upstream: "127.0.0.1:8080",
          models: [{ id: "qwen", label: "Qwen" }],
        },
        hostedProviders: [],
      },
      null,
      2,
    ),
  );
  return path;
};

describe("configuration", () => {
  test("accepts one configured loopback bind and explicit roots", () => {
    const config = loadConfig(writeConfig());
    assert.equal(config.bindHost, "127.0.0.1");
    assert.equal(config.speaker.url, "http://127.0.0.1:7000");
  });

  test("rejects a wildcard bind before opening a listener", () => {
    assert.throws(() => loadConfig(writeConfig("0.0.0.0")), /bindHost must be one exact/);
  });

  test("rejects the same control and guest port", () => {
    assert.throws(() => loadConfig(writeConfig("127.0.0.1", 7002)), /ports must be distinct/);
  });

  test("accepts one configured RFC1918 model endpoint and rejects public endpoints", () => {
    const path = writeConfig();
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.localModel.upstream = "192.168.0.83:9931";
    writeFileSync(path, JSON.stringify(config));
    assert.equal(loadConfig(path).localModel.upstream, "192.168.0.83:9931");
    config.localModel.upstream = "8.8.8.8:9931";
    writeFileSync(path, JSON.stringify(config));
    assert.throws(() => loadConfig(path), /loopback or RFC1918 IPv4/);
  });

});

test("speaker exception permits subject routes only at the configured origin", () => {
  const speaker = new URL("https://speaker.example:7000");
  const allowed = (path: string, method = "GET") => speakerRequestAllowed(speaker, new URL(path, speaker), method);
  assert.ok(allowed("/_speaker/providers"));
  assert.ok(allowed("/_speaker/requests", "POST"));
  assert.ok(allowed("/obsidian/vault/note", "PUT"));
  for (const path of ["/admin", "/admin/api/leases", "/_speaker/subjects", "/_speaker/sessions", "http://speaker.example:7000/obsidian/", "https://speaker.example:8080/obsidian/"])
    assert.equal(allowed(path), false, path);
});

test("enforcer parses refs and rejects malformed secrets and folder modes", () => {
  assert.deepEqual(secretRef.parse("KEY@example.com,*.example.org"), { name: "KEY", hosts: ["example.com", "*.example.org"] });
  for (const ref of ["KEY", "KEY@", "KEY@a@b", "KEY@https://example.com", "KEY@example.com,"])
    assert.equal(secretRef.safeParse(ref).success, false, ref);
  assert.ok(folderRef.safeParse("documents:rw").success);
  assert.equal(folderRef.safeParse("documents:unknown").success, false);
});

test("guest destinations reject all IPv6 forms", () => {
  assert.ok(ipv4Destination("192.168.1.5"));
  for (const ip of ["::1", "fc00::1", "fe80::1", "::ffff:192.168.1.5", "2606:4700:4700::1111"])
    assert.equal(ipv4Destination(ip), false, ip);
});

test("model HTTP exchanges become timed llm runs with bounded-body references", () => {
  const [run] = createModelRuns(
    [
      {
        at: "2026-10-20T10:00:01.000Z",
        durationMs: 750,
        destination: "http://127.0.0.1:9931",
        method: "POST",
        status: 200,
        complete: true,
        requestCapture: "complete",
        responseCapture: "truncated",
        requestBody: {
          path: "blobs/request.bin",
          capturedBytes: 12,
          totalBytes: 12,
          limitBytes: 8_388_608,
          truncated: false,
        },
        responseBody: {
          path: "blobs/response.bin",
          capturedBytes: 32,
          totalBytes: 64,
          limitBytes: 33_554_432,
          truncated: true,
        },
      },
    ],
    {
      modelOrigins: new Set(["http://127.0.0.1:9931"]),
      model: "local/test",
      taskId: "task-1",
      traceId: "trace-1",
    },
  );
  assert.equal(run.run_type, "llm");
  assert.equal(run.start_time, "2026-10-20T10:00:00.250Z");
  assert.equal(run.end_time, "2026-10-20T10:00:01.000Z");
  assert.equal(run.inputs.request_body.path, "blobs/request.bin");
  assert.equal(run.outputs.response_body.truncated, true);
  assert.equal(run.extra.metadata.broker.capture_status, "truncated");
});

test("transport failures become failed llm runs without invented responses", () => {
  const [run] = createModelRuns(
    [
      {
        at: "2026-10-20T10:00:01.000Z",
        durationMs: 100,
        destination: "http://127.0.0.1:9931",
        method: "POST",
        status: 0,
        complete: false,
        error: "connection refused",
        requestCapture: "complete",
        responseCapture: "empty",
      },
    ],
    {
      modelOrigins: new Set(["http://127.0.0.1:9931"]),
      model: "local/test",
      taskId: "task-1",
      traceId: "trace-1",
    },
  );
  assert.equal(run.run_type, "llm");
  assert.deepEqual(run.error, {
    status: 0,
    message: "connection refused",
    capture_status: "incomplete",
  });
  assert.equal(run.outputs.status, 0);
  assert.equal(run.outputs.response_body, null);
});

test("Pi tool runs pair executions by native call id and retain unmatched records", () => {
  const session = { type: "session", id: "session-1" };
  const call = {
    type: "message",
    id: "assistant-1",
    timestamp: "2026-10-20T10:00:00Z",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "notes.txt" } },
      ],
    },
  };
  const result = {
    type: "message",
    id: "result-1",
    timestamp: "2026-10-20T10:00:01Z",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "hello" }],
      isError: false,
    },
  };
  const unmatched = { type: "message", id: "user-1", message: { role: "user", content: [] } };
  const { runs, unassignedRecords } = createToolRuns([session, call, result, unmatched], {
    sessionId: "session-1",
    taskId: "task-1",
    traceId: "trace-1",
    parentRunId: "harness-1",
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run_type, "tool");
  assert.equal(runs[0].parent_run_id, "harness-1");
  assert.equal(runs[0].inputs.path, "notes.txt");
  assert.deepEqual(runs[0].outputs, result.message.content);
  assert.deepEqual(runs[0].extra.metadata.broker.native_records, [call, result]);
  assert.deepEqual(unassignedRecords, [session, unmatched]);
});

test("a streamed chat completion assembles into its finished message", () => {
  const chunk = (body: object) => `data: ${JSON.stringify({ id: "c1", model: "m", ...body })}\n\n`;
  const delta = (value: object, finish_reason: string | null = null) =>
    chunk({ choices: [{ index: 0, delta: value, finish_reason }] });
  const stream =
    delta({ role: "assistant", content: null }) +
    delta({ reasoning_content: "Think" }) +
    delta({ reasoning_content: "ing" }) +
    delta({ content: "Run it." }) +
    delta({
      tool_calls: [
        {
          index: 0,
          id: "t1",
          type: "function",
          function: { name: "bash", arguments: '{"command":' },
        },
      ],
    }) +
    delta({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }) +
    delta({}, "tool_calls") +
    chunk({ choices: [], usage: { completion_tokens: 9 }, timings: { predicted_per_second: 28 } }) +
    "data: [DONE]\n\n";
  assert.deepEqual(assembleStream(stream), {
    id: "c1",
    model: "m",
    content: "Run it.",
    reasoning_content: "Thinking",
    tool_calls: [
      { id: "t1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
    ],
    finish_reason: "tool_calls",
    usage: { completion_tokens: 9 },
    timings: { predicted_per_second: 28 },
  });
});

test("templates load from one file and reject duplicate identities", () => {
  const path = join(mkdtempSync(join(tmpdir(), "bottle-templates-")), "templates.json");
  roots.push(join(path, ".."));
  const templates = JSON.parse(readFileSync(new URL("../templates.json", import.meta.url), "utf8"));
  writeFileSync(path, JSON.stringify(templates));
  assert.deepEqual([...loadTemplates(path).keys()], ["developer", "github-read", "offline", "packages", "research"]);
  writeFileSync(path, JSON.stringify([templates[0], templates[0]]));
  assert.throws(() => loadTemplates(path), /repeat an id/);
  writeFileSync(path, JSON.stringify([{ ...templates[0], bundleDuration: "1h" }]));
  assert.equal(loadTemplates(path).get(templates[0].id)?.bundleDuration, "1h");
  writeFileSync(path, JSON.stringify([{ ...templates[0], bundleDuration: "forever" }]));
  assert.throws(() => loadTemplates(path));
});

test("guest configuration loads the access-and-creds skill alone and the curated MCP tools", () => {
  const config = loadConfig(writeConfig());
  const catalog = Catalog.parse(JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8")));
  const directory = join(config.configRoot, "guest");
  writeGuestConfig(directory, config, catalog, { name: "smoke", model: "local/qwen" }, new Map(), [], ["context7"], []);
  const args = readFileSync(join(directory, "args"), "utf8").trim().split("\n");
  assert.equal(args.filter((arg) => arg === "--skill").length, 1);
  assert.ok(args.includes("/etc/pi-v2/skills/access-and-creds"));
  assert.match(readFileSync(join(directory, "skills/access-and-creds/SKILL.md"), "utf8"), /^name: access-and-creds$/m);
  assert.ok(args.includes("builtin:mcp"));
  assert.match(args[args.indexOf("--tools") + 1]!, /mcp__context7__resolve_library_id/);
});

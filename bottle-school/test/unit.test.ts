import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { Catalog, systemNote, writeGuestConfig } from "../src/pi.ts";
import { assertNoHostSecrets, loadConfig } from "../src/config.ts";
import { attendedFor, folderRef, ipv4Destination, launchRequest, loadTemplates, secretHosts, secretRef, speakerRequestAllowed, Template } from "../src/leases.ts";
import { inForce } from "../src/tasks.ts";
import type { Lease } from "../src/speaker.ts";
import { assembleStream, createModelRuns, createToolRuns } from "../src/trace.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const writeConfig = (bindHost = "127.0.0.1", controlPort = 7001) => {
  const root = mkdtempSync(join(tmpdir(), "bottle-school-config-"));
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
        guestImage: "bottle-school-guest",
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

  test("rejects a backend choice: microsandbox is the only one", () => {
    const path = writeConfig();
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), backend: "gondolin" }));
    assert.throws(() => loadConfig(path), /backend/);
  });

  test("rejects the same control and guest port", () => {
    assert.throws(() => loadConfig(writeConfig("127.0.0.1", 7002)), /ports must be distinct/);
  });

  test("accepts one configured RFC1918 or Tailscale model endpoint and rejects public endpoints", () => {
    const path = writeConfig();
    const config = JSON.parse(readFileSync(path, "utf8"));
    for (const upstream of ["192.168.1.20:8080", "100.100.10.20:8080"]) {
      config.localModel.upstream = upstream;
      writeFileSync(path, JSON.stringify(config));
      assert.equal(loadConfig(path).localModel.upstream, upstream);
    }
    config.localModel.upstream = "8.8.8.8:9931";
    writeFileSync(path, JSON.stringify(config));
    assert.throws(() => loadConfig(path), /loopback, RFC1918, or Tailscale IPv4/);
  });

});

test("speaker exception permits agent routes only at the configured origin", () => {
  const speaker = new URL("https://speaker.example:7000");
  const allowed = (path: string, method = "GET") => speakerRequestAllowed(speaker, new URL(path, speaker), method);
  assert.ok(allowed("/_speaker/me"));
  assert.ok(allowed("/_speaker/help/obsidian"));
  assert.ok(allowed("/_speaker/requests", "POST"));
  assert.ok(allowed("/obsidian/vault/note", "PUT"));
  for (const path of ["/admin", "/admin/api/leases", "/_speaker/hosts/agents", "/_speaker/agents", "/_speaker/providers", "http://speaker.example:7000/obsidian/", "https://speaker.example:8080/obsidian/"])
    assert.equal(allowed(path), false, path);
});

test("enforcer parses refs and rejects malformed secrets and folder modes", () => {
  // A secret grant names a secret in speaker and arrives with the hosts speaker bound it to.
  assert.ok(secretRef.safeParse("GITHUB_TOKEN").success);
  assert.ok(secretHosts.safeParse(["api.github.com", "*.example.org"]).success);
  for (const ref of ["", "KEY@example.com", "KEY@", "KEY.x", "two words"])
    assert.equal(secretRef.safeParse(ref).success, false, ref);
  for (const hosts of [[], undefined, ["https://example.com"], ["Example.com"], [""]])
    assert.equal(secretHosts.safeParse(hosts).success, false, JSON.stringify(hosts));
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
  assert.deepEqual([...loadTemplates(path).keys()], ["developer", "github-read", "loop", "offline", "packages", "research"]);
  writeFileSync(path, JSON.stringify([templates[0], templates[0]]));
  assert.throws(() => loadTemplates(path), /repeat an id/);
  writeFileSync(path, JSON.stringify([{ ...templates[0], duration: "1h" }]));
  assert.equal(loadTemplates(path).get(templates[0].id)?.duration, "1h");
  writeFileSync(path, JSON.stringify([{ ...templates[0], duration: "forever" }]));
  assert.throws(() => loadTemplates(path));
});

test("guest configuration loads the access-and-creds skill alone and the curated MCP tools", () => {
  const config = loadConfig(writeConfig());
  // An MCP server that runs inside the VM; remote ones are speaker services and not catalog entries.
  const catalog = Catalog.parse({
    mcps: { context7: { label: "Docs", transport: "stdio", command: "/opt/mcp/context7", args: [], tools: ["resolve-library-id", "query-docs"], write: false } },
    extensions: {},
  });
  const directory = join(config.configRoot, "guest");
  writeGuestConfig(directory, config, catalog, { name: "smoke", model: "local/qwen", attended: false }, new Map(), [], ["context7"], []);
  const args = readFileSync(join(directory, "args"), "utf8").trim().split("\n");
  assert.equal(args.filter((arg) => arg === "--skill").length, 1);
  assert.ok(args.includes("/etc/bottle-school/skills/access-and-creds"));
  assert.match(readFileSync(join(directory, "skills/access-and-creds/SKILL.md"), "utf8"), /^name: access-and-creds$/m);
  assert.ok(args.includes("builtin:mcp"));
  assert.match(args[args.indexOf("--tools") + 1]!, /mcp__context7__resolve_library_id/);
});

test("attended defaults to no-prompt launches, follows the launch flag, and a template can force it", () => {
  const free = Template.parse({
    id: "free",
    label: "Free",
    limits: { cpus: 1, memoryMiB: 512, rootfsGiB: 1, workGiB: 1, maxRuntimeHours: 1 },
  });
  assert.equal(attendedFor(free, {}), true);
  assert.equal(attendedFor(free, { prompt: "do it" }), false);
  assert.equal(attendedFor(free, { prompt: "do it", attended: true }), true);
  assert.equal(attendedFor(free, { attended: false }), false);
  const forced = { ...free, id: "forced", attended: false };
  assert.equal(attendedFor(forced, {}), false);
  assert.equal(attendedFor(forced, { attended: false }), false);
  assert.throws(() => attendedFor(forced, { attended: true }), /always unattended/);
});

test("attended mode loads ask-user-question; extension leases load catalog extensions and their tools", () => {
  const config = loadConfig(writeConfig());
  const catalog = Catalog.parse(JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8")));
  const write = (attended: boolean, extensions: string[], prompt?: string) => {
    const directory = join(config.configRoot, `guest-${attended}-${extensions.join("-")}`);
    writeGuestConfig(directory, config, catalog, { name: "t", model: "local/qwen", prompt, attended }, new Map(), [], [], extensions);
    const args = readFileSync(join(directory, "args"), "utf8").trim().split("\n");
    const loaded = args.flatMap((arg, index) => (args[index - 1] === "-e" ? [arg] : []));
    const tools = args[args.indexOf("--tools") + 1]!.split(",");
    return { loaded, tools, system: readFileSync(join(directory, "APPEND_SYSTEM.md"), "utf8"), directory };
  };

  const attended = write(true, []);
  assert.deepEqual(attended.loaded, ["/etc/bottle-school/extensions/request-capability.ts", "/opt/pi-plugins/rpiv-ask-user-question"]);
  assert.ok(attended.tools.includes("ask_user_question"));
  assert.match(attended.system, /## Attended task/);

  const research = write(false, ["pi-web-access"], "Find three sources");
  assert.deepEqual(research.loaded, ["/etc/bottle-school/extensions/request-capability.ts", "/opt/pi-plugins/pi-web-access"]);
  assert.ok(research.tools.includes("web_search") && !research.tools.includes("ask_user_question"));
  assert.match(research.system, /## Unattended task[\s\S]*Nobody is watching[\s\S]*## Owner prompt\n\nFind three sources$/);
  const webSearch = JSON.parse(readFileSync(join(research.directory, "web-search.json"), "utf8"));
  assert.deepEqual(webSearch.webSearch.allowedProviders, ["exa"]);
  assert.deepEqual(webSearch.fetchRouting, { providers: ["http"], allowRemoteHostedProviders: false });

  const loop = write(false, ["pi-cc-loop", "pi-cc-monitor"]);
  assert.ok(loop.tools.includes("schedule_wakeup") && loop.tools.includes("Monitor"));
  assert.match(loop.system, /## Extension pi-cc-loop[\s\S]*maxFires[\s\S]*durable: true/);
  assert.throws(() => write(false, ["nope"]), /unknown extension nope/);
});

const limits = { cpus: 1, memoryMiB: 512, rootfsGiB: 1, workGiB: 1, maxRuntimeHours: 1 };

test("a template's want, label and duration become the task's first request", () => {
  const dev = Template.parse({ id: "dev", label: "Develop things", limits, want: ["group:developer", "site:pypi.org"], duration: "1d" });
  assert.deepEqual(launchRequest(dev, "agent-1"), {
    agentId: "agent-1",
    want: ["group:developer", "site:pypi.org"],
    reason: "launch template dev: Develop things",
    duration: "1d",
  });
  // A hosted model's key is a speaker secret and joins the same request, without repeating an item.
  assert.deepEqual(launchRequest(dev, "agent-1", ["secret:OPENROUTER", "site:pypi.org"])?.want, [
    "group:developer",
    "site:pypi.org",
    "secret:OPENROUTER",
  ]);
  // No want, no request; the default duration is speaker's default.
  const bare = Template.parse({ id: "bare", label: "Bare", limits });
  assert.equal(launchRequest(bare, "agent-1"), undefined);
  assert.equal(bare.duration, "2h");
  // The old single `bundle` is gone: an old templates.json fails loudly instead of asking for nothing.
  assert.throws(() => Template.parse({ id: "old", label: "Old", limits, bundle: "developer" }), /bundle/);

  const shipped = loadTemplates(new URL("../templates.json", import.meta.url).pathname);
  assert.deepEqual(shipped.get("developer")?.want, ["group:developer"]);
  assert.deepEqual(shipped.get("offline")?.want, []);
});

test("grants count as in force when installed, MCP and extension ones once Pi runs them, expired ones never", () => {
  const lease = (id: string, kind: string, ref: string, expiresAt: string | null = null): Lease => ({ id, kind, ref, expiresAt, subjectId: "s" });
  const leases = [
    lease("site", "site", "example.com"),
    lease("secret", "secret", "GITHUB_TOKEN"),
    lease("folder", "folder", "documents"),
    lease("mcp", "mcp", "docs"),
    lease("ext", "extension", "pi-web-access"),
    lease("gone", "site", "old.example", "2000-01-01T00:00:00Z"),
  ];
  assert.deepEqual(inForce(leases, { mcp: [], extensions: [] }), ["site", "secret", "folder"]);
  assert.deepEqual(inForce(leases, { mcp: ["docs"], extensions: [] }), ["site", "secret", "folder", "mcp"]);
  assert.deepEqual(inForce(leases, { mcp: ["docs"], extensions: ["pi-web-access"] }), ["site", "secret", "folder", "mcp", "ext"]);
});

test("bottle-school refuses to start while a secrets file or BROKER_SECRET variable is left on the host", () => {
  const root = mkdtempSync(join(tmpdir(), "bottle-secrets-"));
  roots.push(root);
  assertNoHostSecrets({ configRoot: root }, {});
  assert.throws(() => assertNoHostSecrets({ configRoot: root }, { BROKER_SECRET_OPENROUTER: "x" }), /add BROKER_SECRET_OPENROUTER to speaker's Setup/);
  writeFileSync(join(root, "secrets.env"), "BROKER_SECRET_X=y\n");
  assert.throws(() => assertNoHostSecrets({ configRoot: root }, {}), /secrets\.env/);
});

test("remote MCP servers are not catalog entries; the shipped catalog keeps only in-VM servers and extensions", () => {
  const shipped = Catalog.parse(JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8")));
  assert.deepEqual(shipped.mcps, {});
  assert.ok(shipped.extensions["pi-web-access"]);
  const remote = { label: "Docs", transport: "streamable-http", url: "https://mcp.example.com/mcp", tools: ["query"], write: false };
  assert.throws(() => Catalog.parse({ mcps: { docs: remote }, extensions: {} }), /only MCP servers that run inside the VM/);
});

test("Pi's instructions name the mcp and ext entries and the secrets, and say how to use a secret", () => {
  const catalog = Catalog.parse({
    mcps: { filesystem: { label: "Files", transport: "stdio", command: "/opt/mcp/fs", args: [], tools: ["read_file"], write: false } },
    extensions: JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8")).extensions,
  });
  const secrets = [{ name: "GITHUB_TOKEN", hosts: ["api.github.com", "github.com"], env: "GH_TOKEN" }];
  const note = systemNote({ name: "t", attended: false }, [], catalog, [], secrets);
  assert.match(note, /- mcp:filesystem: Files; tools: read_file/);
  assert.match(note, /- ext:pi-web-access: /);
  assert.match(note, /- secret:GITHUB_TOKEN: set GH_TOKEN to its placeholder; used for api\.github\.com, github\.com/);
  assert.match(note, /## Using a secret[\s\S]*secrets\.<NAME>[\s\S]*placeholder[\s\S]*GH_TOKEN=<placeholder> gh pr list[\s\S]*proxy/);
  // Remote MCP servers are speaker services.
  assert.match(note, /`<service>\.read` or `<service>\.full`[\s\S]*\$SPEAKER_URL\/<service>[\s\S]*never `mcp:` items/);
  // With nothing set up the lists say so.
  assert.match(systemNote({ name: "t", attended: false }, [], { mcps: {}, extensions: {} }, []), /## Secrets you can ask for\n\n- none/);
});

test("a hosted model's key in models.json is the placeholder speaker issued, never a secret", () => {
  const base = loadConfig(writeConfig());
  const config = {
    ...base,
    hostedProviders: [
      { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", host: "openrouter.ai", credential: "OPENROUTER", models: [{ id: "m", label: "M" }] },
    ],
  };
  const catalog = { mcps: {}, extensions: {} };
  const task = { name: "t", model: "openrouter/m", attended: false };
  const apiKey = (keys: Map<string, string>, name: string) => {
    const directory = join(base.configRoot, name);
    writeGuestConfig(directory, config, catalog, task, keys, [], [], []);
    return JSON.parse(readFileSync(join(directory, "models.json"), "utf8")).providers.openrouter.apiKey;
  };
  assert.equal(apiKey(new Map([["OPENROUTER", "speaker-placeholder-abc"]]), "granted"), "speaker-placeholder-abc");
  assert.match(apiKey(new Map(), "waiting"), /not-granted-yet/);
});

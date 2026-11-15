import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { itemPatterns } from "../../speaker/items.ts";
import { Catalog, grantChange, loadCatalog, systemNote, writeGuestConfig } from "../src/pi.ts";
import { loadConfig } from "../src/config.ts";
import { attendedFor, launchRequest, loadTemplates, refOf, secretHosts, speakerRequestAllowed, Template } from "../src/grants.ts";
import { inForce } from "../src/tasks.ts";
import { catalogReport, type Grant } from "../src/speaker.ts";
import {
  alreadyPendingText,
  changeMessage,
  decisionMessage,
  FIXED_GUIDANCE,
  filedText,
  grantedLine,
  pendingKey,
  piToolNames,
  reply,
  type CatalogView,
} from "../guest/extensions/reply.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const writeConfig = (bindHost = "127.0.0.1", controlPort = 7001) => {
  const root = mkdtempSync(join(tmpdir(), "bottle-config-"));
  roots.push(root);
  for (const name of ["config", "state", "output"]) mkdirSync(join(root, name));
  const path = join(root, "config.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        bindHost,
        controlPort,
        guestPort: 7002,
        speaker: { url: "http://127.0.0.1:7000", proxyPort: 7003, sshPort: 7004 },
        maxTasks: 1,
        guestImage: "bottle-guest",
        configRoot: join(root, "config"),
        stateRoot: join(root, "state"),
        outputRoot: join(root, "output"),
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
  const allowed = (path: string, method = "GET") => speakerRequestAllowed(speaker, new URL(path, speaker), method, ["openrouter"]);
  assert.ok(allowed("/_speaker/catalog"));
  assert.ok(allowed("/_speaker/help/obsidian"));
  assert.ok(allowed("/_speaker/requests", "POST"));
  assert.ok(allowed("/_speaker/requests/abc123"));
  assert.equal(allowed("/_speaker/requests/abc123", "POST"), false);
  assert.ok(allowed("/obsidian/vault/note", "PUT"));
  for (const path of [
    "/admin",
    "/admin/api/leases",
    // A hosted model's service is for the model door only (its cap and model-calls.jsonl), however the path is spelled.
    "/openrouter",
    "/openrouter/chat/completions",
    "/obsidian/../openrouter/chat/completions",
    "/%6Fpenrouter/chat/completions",
    "/_speaker/hosts/agents",
    "/_speaker/agents",
    "/_speaker/providers",
    "http://speaker.example:7000/obsidian/",
    "https://speaker.example:8080/obsidian/",
  ])
    assert.equal(allowed(path), false, path);
});

test("enforcer reads items by the shared grammar and rejects malformed secret hosts and folder modes", () => {
  // A secret grant names a secret in speaker and arrives with the hosts speaker bound it to.
  assert.ok(itemPatterns.secret.test("secret:GITHUB_TOKEN"));
  assert.ok(secretHosts.safeParse(["api.github.com", "*.example.org"]).success);
  for (const item of ["secret:", "secret:KEY@example.com", "secret:KEY.x", "secret:two words"]) assert.equal(itemPatterns.secret.test(item), false, item);
  for (const hosts of [[], undefined, ["https://example.com"], ["Example.com"], [""]])
    assert.equal(secretHosts.safeParse(hosts).success, false, JSON.stringify(hosts));
  assert.ok(itemPatterns.folder.test("folder:documents:rw"));
  assert.equal(itemPatterns.folder.test("folder:documents:unknown"), false);
  assert.deepEqual(["site:example.com", "folder:docs:rw", "notes.read"].map(refOf), ["example.com", "docs:rw", "notes.read"]);
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

test("guest configuration mounts no skills, sends no extension config for an MCP-only task, and loads the curated MCP tools", () => {
  const config = loadConfig(writeConfig());
  // An MCP server that runs inside the VM; remote ones are speaker services and not catalog entries.
  const catalog = Catalog.parse({
    mcps: {
      context7: { label: "Docs", transport: "stdio", command: "/opt/mcp/context7", args: [], tools: ["resolve-library-id", "query-docs"], write: false },
    },
    extensions: {},
  });
  const directory = join(config.configRoot, "guest");
  writeGuestConfig(directory, config, catalog, { name: "smoke", model: "local/qwen", attended: false }, [], ["context7"], []);
  const args = readFileSync(join(directory, "args"), "utf8").trim().split("\n");
  assert.equal(args.includes("--skill"), false);
  assert.equal(existsSync(join(directory, "skills")), false);
  assert.ok(existsSync(join(directory, "extensions/reply.ts")));
  assert.deepEqual(readdirSync(join(directory, "agent-files")), []);
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

test("attended mode loads ask-user-question; ext: grants load catalog extensions and their tools", () => {
  const config = loadConfig(writeConfig());
  const catalog = Catalog.parse(JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8")));
  const write = (attended: boolean, extensions: string[], prompt?: string) => {
    const directory = join(config.configRoot, `guest-${attended}-${extensions.join("-")}`);
    writeGuestConfig(directory, config, catalog, { name: "t", model: "local/qwen", prompt, attended }, [], [], extensions);
    const args = readFileSync(join(directory, "args"), "utf8").trim().split("\n");
    const loaded = args.flatMap((arg, index) => (args[index - 1] === "-e" ? [arg] : []));
    const tools = args[args.indexOf("--tools") + 1]!.split(",");
    return { loaded, tools, system: readFileSync(join(directory, "APPEND_SYSTEM.md"), "utf8"), directory };
  };

  const attended = write(true, []);
  assert.deepEqual(attended.loaded, ["/etc/bottle/extensions/request-capability.ts", "/opt/pi-plugins/rpiv-ask-user-question"]);
  assert.ok(attended.tools.includes("ask_user_question"));
  assert.match(attended.system, /## Attended task/);

  const research = write(false, ["pi-web-access"], "Find three sources");
  assert.deepEqual(research.loaded, ["/etc/bottle/extensions/request-capability.ts", "/opt/pi-plugins/pi-web-access"]);
  assert.ok(research.tools.includes("web_search") && !research.tools.includes("ask_user_question"));
  assert.match(research.system, /## Unattended task[\s\S]*Nobody is watching[\s\S]*## Owner prompt\n\nFind three sources$/);
  const webSearch = JSON.parse(readFileSync(join(research.directory, "agent-files/web-search.json"), "utf8"));
  assert.deepEqual(webSearch.webSearch.allowedProviders, ["exa"]);
  assert.deepEqual(webSearch.fetchRouting, { providers: ["http"], allowRemoteHostedProviders: false });
  assert.equal(webSearch.ssrf.trustEnvProxy, true);
  assert.equal(webSearch.allowBrowserCookies, false);
  // Config files follow the extension: a task without it gets none.
  assert.equal(existsSync(join(write(false, ["pi-cc-loop"]).directory, "agent-files/web-search.json")), false);

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
  // A hosted model's speaker service joins the same request, without repeating an item.
  assert.deepEqual(launchRequest(dev, "agent-1", ["openrouter.full", "site:pypi.org"])?.want, ["group:developer", "site:pypi.org", "openrouter.full"]);
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
  const grant = (id: string, item: string, expiresAt: string | null = null): Grant => ({ id, item, expiresAt, agentId: "s" });
  const grants = [
    grant("site", "site:example.com"),
    grant("secret", "secret:GITHUB_TOKEN"),
    grant("folder", "folder:documents"),
    grant("mcp", "mcp:docs"),
    grant("ext", "ext:pi-web-access"),
    grant("gone", "site:old.example", "2000-01-01T00:00:00Z"),
  ];
  assert.deepEqual(inForce(grants, { mcp: [], ext: [] }), ["site", "secret", "folder"]);
  assert.deepEqual(inForce(grants, { mcp: ["docs"], ext: [] }), ["site", "secret", "folder", "mcp"]);
  assert.deepEqual(inForce(grants, { mcp: ["docs"], ext: ["pi-web-access"] }), ["site", "secret", "folder", "mcp", "ext"]);
});

test("remote MCP servers are not catalog entries; the shipped catalog keeps only in-VM servers and extensions", () => {
  const shipped = Catalog.parse(JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8")));
  assert.deepEqual(shipped.mcps, {});
  assert.ok(shipped.extensions["pi-web-access"]);
  const remote = { label: "Docs", transport: "streamable-http", url: "https://mcp.example.com/mcp", tools: ["query"], write: false };
  assert.throws(() => Catalog.parse({ mcps: { docs: remote }, extensions: {} }), /only MCP servers that run inside the VM/);
});

test("Pi's instructions point to request_capability and carry no item list", () => {
  const catalog = Catalog.parse({ mcps: {}, extensions: JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8")).extensions });
  const note = systemNote({ name: "t", attended: false }, [], catalog, []);
  assert.match(note, /call `request_capability`\. Its description lists what you can ask for/);
  for (const gone of ["site:<host>", "Using a secret", "ext:pi-web-access", "access-and-creds", "_speaker/me"]) assert.equal(note.includes(gone), false, gone);
});

test("the shipped extensions declare the sites they contact, and the host reports them to speaker", () => {
  const shipped = Catalog.parse(JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8")));
  assert.deepEqual(shipped.extensions["pi-web-access"]!.sites, ["mcp.exa.ai"]);
  const report = catalogReport(shipped);
  assert.deepEqual(report.extensions.find((entry) => entry.id === "pi-web-access")!.sites, ["mcp.exa.ai"]);
  assert.deepEqual(report.mcps, []);
});

test("replies tell the agent what to do, per item kind", () => {
  const catalog: CatalogView = {
    secrets: { GITHUB_READ: { hosts: ["github.com", "api.github.com"], env: "GH_TOKEN", placeholder: "ph-1", environment: { GH_TOKEN: "ph-1" } } },
    services: { vault: { mcp: true } },
    extensions: { "pi-web-access": { tools: ["web_search", "fetch_content"] } },
  };
  const at = "2099-01-01T14:30:00Z";
  const line = (item: string, help?: string) => grantedLine(item, catalog, at, help);
  assert.match(line("site:pypi.org"), /^Granted: site:pypi\.org until .*14:30 UTC\. Requests to pypi\.org now go through\. Retry what failed\.$/);
  assert.match(line("secret:GITHUB_READ"), /Put GH_TOKEN=ph-1 in front of the one command[\s\S]*only for github\.com and api\.github\.com\. Do not print it/);
  assert.match(line("folder:photos"), /read-only.*Its files are in \/input\/photos\. You cannot write there; put results in \/output\./);
  assert.match(line("folder:photos:rw"), /read-write.*You can write there\./);
  assert.match(
    line("obsidian.read", "Paths are vault-relative."),
    /curl -H "Authorization: Bearer \$SPEAKER_TOKEN" \$SPEAKER_URL\/obsidian\/<path>.*Paths are vault-relative\./,
  );
  assert.match(
    line("vault.read"),
    /It is an MCP server\. Send JSON-RPC with POST to \$SPEAKER_URL\/vault: first initialize, then tools\/list, then tools\/call\./,
  );
  assert.match(
    line("ext:pi-web-access"),
    /\(web_search, fetch_content\) load the next time you pause; you will get a message when they are available\. Keep working/,
  );
  assert.deepEqual(piToolNames("ext:pi-web-access", catalog), ["web_search", "fetch_content"]);
  assert.match(
    reply({ status: "decided", denied: ["folder:temp"] }, catalog),
    /^Denied: folder:temp\. Do not ask for it again in this task\..*\/output\/NOTES\.md\.$/,
  );
  assert.throws(() => line("secret:MISSING"), /does not show/);
});

test("request_capability answers at once and delivers the decision as one [speaker] message", () => {
  const catalog: CatalogView = { extensions: { "web-search": { tools: ["web_search"] } } };
  assert.match(filedText(7), /^Filed as request 7\. Not decided yet\. Keep working .*starting `\[speaker\]`.*Don't ask again for the same items\.$/);
  assert.match(alreadyPendingText(7), /^Already pending as request 7\. Not decided yet\./);
  assert.equal(pendingKey(["site:b", "site:a", "site:b"]), pendingKey(["site:a", "site:b"]));
  assert.equal(FIXED_GUIDANCE.includes("30 minutes"), false);
  const granted = decisionMessage({ status: "decided", granted: ["site:pypi.org"] }, ["site:pypi.org"], catalog);
  assert.match(granted, /^\[speaker\] Granted: site:pypi\.org.*Retry what failed\.$/);
  assert.match(
    decisionMessage({ status: "decided", denied: ["secret:X"] }, ["secret:X"], catalog),
    /^\[speaker\] Denied: secret:X\. Do not ask for it again.*Do the work without it/,
  );
  assert.match(
    decisionMessage({ status: "decided", granted: ["ext:web-search"] }, ["ext:web-search"], catalog),
    /^\[speaker\] Granted: ext:web-search.*\(web_search\) load the next time you pause; you will get a message when they are available\. Keep working/,
  );
  assert.equal(
    decisionMessage({ status: "expired" }, ["site:a", "site:b"], catalog),
    "[speaker] The owner did not decide on site:a, site:b. Ask again only if you still need it.",
  );
});

test("a hosted model in models.json points at the model door and holds no key; without a local model there is no local provider", () => {
  const path = writeConfig();
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.localModel = { guestHost: "model.internal" };
  writeFileSync(path, JSON.stringify(raw));
  assert.throws(() => loadConfig(path), /a local model or a hosted provider/);
  raw.hostedProviders = [
    { id: "openrouter", service: "openrouter", models: [{ id: "m", label: "M" }] },
    { id: "anthropic", service: "anthropic", api: "anthropic-messages", models: [{ id: "c", label: "C" }] },
  ];
  writeFileSync(path, JSON.stringify(raw));
  const config = loadConfig(path);
  const directory = join(config.configRoot, "hosted");
  writeGuestConfig(directory, config, { mcps: {}, extensions: {} }, { name: "t", model: "anthropic/c", attended: false }, [], [], []);
  const { providers } = JSON.parse(readFileSync(join(directory, "models.json"), "utf8"));
  assert.deepEqual(Object.keys(providers), ["openrouter", "anthropic"]);
  assert.deepEqual(
    [providers.openrouter.baseUrl, providers.openrouter.api, providers.anthropic.api, providers.anthropic.apiKey],
    [`http://model.internal/hosted/openrouter`, "openai-completions", "anthropic-messages", "speaker-service"],
  );
});

test("the change message lists what loaded, what did not and what was removed", () => {
  const change = { id: 2, added: ["ext:notes", "mcp:db"], removed: ["ext:old"], tools: { added: ["note", "mcp__db__q"], removed: ["old_tool"] } };
  assert.equal(
    changeMessage(change, ["read", "note"]),
    "Pi restarted because your grants changed. Now available: note (from ext:notes, mcp:db). These did not load: mcp__db__q. " +
      "Removed, do not use: ext:old, old_tool. Continue the task.",
  );
  assert.equal(
    changeMessage({ id: 3, added: [], removed: ["ext:notes"], tools: { added: [], removed: ["note"] } }, ["read"]),
    "Pi restarted because your grants changed. Removed, do not use: ext:notes, note. Continue the task.",
  );
});

test("grantChange diffs the loadout and names tools as Pi registers them", () => {
  const catalog = Catalog.parse({
    mcps: { "my-db": { label: "DB", transport: "stdio", command: "/bin/db", args: [], tools: ["run-query"], write: false } },
    extensions: { notes: { label: "N", guestPath: "/opt/n", description: "d", tools: ["note"], sites: [] } },
  });
  assert.deepEqual(grantChange(catalog, 5, ["ext:notes"], ["mcp:my-db"]), {
    id: 5,
    added: ["mcp:my-db"],
    removed: ["ext:notes"],
    tools: { added: ["mcp__my_db__run_query"], removed: ["note"] },
  });
});

test("catalog extensions carry config files that only a task loading the extension receives", () => {
  const config = loadConfig(writeConfig());
  const entry = { label: "Notes", guestPath: "/opt/pi-plugins/notes", description: "Notes", tools: ["note"], sites: [] };
  const catalog = Catalog.parse({
    mcps: {},
    extensions: { notes: { ...entry, files: { "notes.json": { a: 1 }, "notes.txt": "plain" } }, other: { ...entry, guestPath: "/opt/pi-plugins/other" } },
  });
  const write = (name: string, extIds: string[]) => {
    const directory = join(config.configRoot, name);
    writeGuestConfig(directory, config, catalog, { name: "t", model: "local/qwen", attended: false }, [], [], extIds);
    return join(directory, "agent-files");
  };
  const withNotes = write("with", ["notes"]);
  assert.deepEqual(JSON.parse(readFileSync(join(withNotes, "notes.json"), "utf8")), { a: 1 });
  assert.equal(readFileSync(join(withNotes, "notes.txt"), "utf8"), "plain");
  assert.deepEqual(readdirSync(write("without", ["other"])), []);
  // A restart that drops the extension removes its files from the same directory.
  assert.deepEqual(readdirSync(write("with", ["other"])), []);
  for (const name of ["../x.json", "sub/x.json", "models.json"])
    assert.throws(
      () => Catalog.parse({ mcps: {}, extensions: { notes: { ...entry, files: { [name]: {} } } } }),
      name === "models.json" ? /bottle's own/ : /no directory part/,
    );
});

test("the catalog is checked against the guest image's plugin manifest, and a missing path names the entry and the fix", () => {
  const config = loadConfig(writeConfig());
  const entry = { label: "X", description: "X", tools: [], sites: [] };
  const save = (extensions: object) => writeFileSync(join(config.configRoot, "catalog.json"), JSON.stringify({ mcps: {}, extensions }));
  save({ good: { ...entry, guestPath: "/opt/pi-plugins/good" } });
  assert.throws(() => loadCatalog(config), /guest-plugins\.txt is missing.*bottle build/);
  writeFileSync(join(config.stateRoot, "guest-plugins.txt"), "/opt/pi-plugins/good\n");
  assert.deepEqual(Object.keys(loadCatalog(config).extensions), ["good"]);
  save({ good: { ...entry, guestPath: "/opt/pi-plugins/good" }, typo: { ...entry, guestPath: "/opt/pi-plugins/gooood" } });
  assert.throws(() => loadCatalog(config), /extension "typo" names \/opt\/pi-plugins\/gooood.*not in the guest image.*pi-package\.json and run bottle build/);
});

test("the shipped catalog parses", () => {
  Catalog.parse(JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8")));
});

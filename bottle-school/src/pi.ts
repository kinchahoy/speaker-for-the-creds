import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Guest } from "./sandbox.ts";
import { unexpired } from "./leases.ts";
import type { Lease, SecretInfo } from "./speaker.ts";

/**
 * An MCP server that runs inside the VM from an image-local command. Remote and hosted MCP servers are not catalog
 * entries: they are speaker services (`<service>.read` / `.full`), reached at `$SPEAKER_URL/<service>`.
 */
const McpEntry = z
  .object({
    label: z.string().min(1),
    transport: z.literal("stdio", "only MCP servers that run inside the VM are catalog entries; add remote ones as speaker services"),
    command: z.string().startsWith("/", "an MCP command is an image-local absolute path"),
    args: z.array(z.string()),
    tools: z.array(z.string().regex(/^[a-z0-9_-]+$/)).min(1),
    write: z.boolean(),
  })
  .strict();

export const Catalog = z
  .object({
    mcps: z.record(z.string().regex(/^[a-z0-9-]+$/), McpEntry),
    /** Opt-in Pi extensions; an approved `extension` lease names one of these ids. */
    extensions: z.record(
      z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      z
        .object({
          label: z.string().min(1),
          guestPath: z.string().startsWith("/", "an extension lives in the pinned guest image"),
          description: z.string().min(1),
          /** The tools the extension registers; `--tools` is an allowlist, so unlisted tools stay hidden. */
          tools: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)),
          /** Guidance appended to the system prompt while the extension is loaded. */
          note: z.string().min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((catalog, context) => {
    for (const [id, entry] of Object.entries(catalog.mcps)) {
      if (new Set(entry.tools).size !== entry.tools.length)
        context.addIssue({
          code: "custom",
          path: ["mcps", id, "tools"],
          message: "an MCP catalog entry repeats a tool",
        });
    }
  });

export type Catalog = z.infer<typeof Catalog>;

const SESSION = "/work/.pi-session/task.jsonl";
/** Commands the guest image provides. */
export const CLI_TOOLS = `
  rg ctags jq sqlite3 git gh curl wget tree file shellcheck uv gcc make node pnpm cmake pandoc
  pdftotext qpdf tesseract magick dot ffmpeg hyperfine tmux
`.trim().split(/\s+/);
const BUILT_IN_TOOLS = "read,bash,edit,write,grep,find,ls,request_capability";

/** Hosted providers listed in models.json work once their key, a speaker secret, is granted to the task. */
export const availableModels = (config: Config) => [
  ...config.localModel.models.map((model) => ({
    id: `local/${model.id}`,
    label: `${model.label} (host-local)`,
  })),
  ...config.hostedProviders.flatMap((provider) =>
    provider.models.map((model) => ({
      id: `${provider.id}/${model.id}`,
      label: `${model.label} (${provider.id})`,
    })),
  ),
];

const modelIds = (models: { id: string }[]) => models.map(({ id }) => ({ id }));

/** `keys` holds the placeholder speaker issued for each granted provider secret; until then Pi is told it is missing. */
const modelsJson = (config: Config, keys: Map<string, string>) => ({
  providers: {
    local: {
      baseUrl: `http://${config.localModel.guestHost}/v1`,
      api: "openai-completions",
      apiKey: "local",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: modelIds(config.localModel.models),
    },
    ...Object.fromEntries(
      config.hostedProviders.map((provider) => [
        provider.id,
        {
          // The guest has no route to the provider: its model endpoint forwards /hosted/<id>/... there.
          baseUrl: `http://${config.localModel.guestHost}/hosted/${provider.id}${new URL(provider.baseUrl).pathname}`,
          api: "openai-completions",
          // Speaker's proxy swaps this placeholder for the real key in requests to the secret's hosts.
          apiKey: keys.get(provider.credential) ?? `speaker-secret-${provider.credential}-not-granted-yet`,
          models: modelIds(provider.models),
        },
      ]),
    ),
  },
});

export const systemNote = (
  task: { name: string; prompt?: string; attended: boolean },
  leases: Lease[],
  catalog: Catalog,
  extensionIds: string[],
  secrets: SecretInfo[] = [],
) => {
  const rows = unexpired(leases).map(
    (lease) =>
      `${lease.kind} ${lease.ref} (${lease.expiresAt ? `expires ${lease.expiresAt}` : "permanent"})`,
  );
  const mcpCatalog =
    Object.entries(catalog.mcps)
      .map(
        ([id, entry]) =>
          `- mcp:${id}: ${entry.label}; tools: ${entry.tools.join(", ")}; ${entry.write ? "can write" : "read-only"}`,
      )
      .join("\n") || "- none";
  const secretCatalog =
    secrets
      .map(({ name, hosts, env }) => `- secret:${name}: set ${env} to its placeholder; used for ${hosts.join(", ")}`)
      .join("\n") || "- none";
  const extensionCatalog =
    Object.entries(catalog.extensions)
      .map(([id, entry]) => `- ext:${id}: ${entry.label}. ${entry.description}${extensionIds.includes(id) ? " (loaded)" : ""}`)
      .join("\n") || "- none";
  const notes = extensionIds.flatMap((id) => {
    const note = catalog.extensions[id]?.note;
    return note ? ["", `## Extension ${id}`, "", note] : [];
  });
  return [
    `# Task: ${task.name}`,
    "",
    "You run inside a disposable micro-VM.",
    "",
    "- `/input` holds host folders the owner leased to you. Each is read-only unless its lease says `:rw`.",
    "- `/work` is your scratch space. It holds this session. The owner destroys it when the task closes.",
    "- `/output` is permanent. Write everything the owner should keep there.",
    "- Work directly on the owner's goal. Keep updates concise.",
    "- Deliver the simplest working version first. Improve it only when the owner asks.",
    "- Do not read a tool's source code to debug it. Use `--help` or the docs, or try another approach.",
    "- When the owner says stop or wrap up, hand over what exists in that same turn.",
    "- Test each deliverable the way its user will use it. Fix failures before moving on.",
    "- Record assumptions and anything unfinished in `/output/NOTES.md`. One line is fine. State only what you observed.",
    "- Write `/output/DONE` (one line saying what was delivered) only when the whole task is complete and verified. Never write it for partial work.",
    "- When blocked, say so in `/output/NOTES.md` and in your final reply.",
    "",
    "## Environment",
    "",
    `- CLI tools: ${CLI_TOOLS.join(", ")}.`,
    "- Python: always use uv. Run scratch code with `uv run python` and `uv run pytest`, which use the default environment. For a project, use `uv init`, `uv add`, and `uv run`. There is no bare `python` or `pip`.",
    "- JavaScript work: write TypeScript. Run it with `node file.ts`. Check types with `tsc --noEmit`. Manage packages with pnpm, lint with `oxlint`, and format with `oxfmt`.",
    "- Browser automation: Playwright with headless Chromium is installed.",
    "- To get a missing tool or library, install it from a package registry: `uv add` (PyPI) or `pnpm add` (npm). Many CLI tools ship there. Request direct binary downloads (for example GitHub releases) only when no registry package exists.",
    "- Common `site:` hosts: PyPI `pypi.org`, `files.pythonhosted.org`; npm `registry.npmjs.org`; GitHub `github.com`, `codeload.github.com`, `raw.githubusercontent.com`. For other sites, request the exact hostnames the tool contacts, and check redirects. Prefer a group (`group:<name>`, listed by `GET /_speaker/me`) when it covers three or more of the items you need.",
    "- For homelab APIs, remote MCP servers, and every other item kind, follow the `access-and-creds` skill.",
    "",
    "## Leases at this Pi start",
    "",
    ...(rows.length ? rows.map((row) => `- ${row}`) : ["- none"]),
    "",
    "A lease ends at its expiry time. After that, requests it covered return 403 until the owner approves a new one.",
    "A denied HTTP request returns 403. The owner can change leases while you run, so trust the result of the request over this list.",
    "When a lease blocks work you need, call `request_capability` once, with `want` set to a list of every item you need. It waits for the owner's decision and returns what was granted and denied. Meanwhile, continue independent work.",
    "Items you can request:",
    "",
    "- `site:<host>`: a hostname such as `site:pypi.org`, or `site:*.example.com` (subdomains only). Request several hostnames in one call.",
    "- `secret:<NAME>`: use one of the owner's secrets (listed below) on the hosts the owner bound it to, without seeing it. Granting it also opens those hosts.",
    "- `folder:<share>` for read-only access, or `folder:<share>:rw` to write. Once granted, it is at `/input/<share>`.",
    "- `mcp:<id>`: an MCP server that runs inside this VM, from the MCP catalog below (if any; exact id). It starts after Pi restarts at idle.",
    "- `ext:<id>`: an extension from the extension catalog below (if any; exact id). Its tools appear after Pi restarts at idle, and this session resumes.",
    "- `<service>.read` or `<service>.full`: a homelab API or a remote MCP server, which speaker hosts. Call `$SPEAKER_URL/<service>` with `Authorization: Bearer $SPEAKER_TOKEN`. `/me` marks MCP services `mcp: true`; they take Streamable HTTP JSON-RPC (POST). Remote MCP servers are never `mcp:` items.",
    "",
    "## Using a secret",
    "",
    "After `secret:<NAME>` is granted, `GET $SPEAKER_URL/_speaker/me` shows `secrets.<NAME>`: a variable whose value is a placeholder. Set it on the one command that needs it, for example `GH_TOKEN=<placeholder> gh pr list`. For `git`, run `gh auth setup-git` once. Speaker's proxy swaps in the real value on the way out. Never print the placeholder or your speaker token.",
    "",
    "## Secrets you can ask for",
    "",
    secretCatalog,
    "",
    "## Available MCP catalog (run inside this VM)",
    "",
    mcpCatalog,
    "",
    "## Available extension catalog",
    "",
    extensionCatalog,
    "",
    "Request access up front when you know you need it. Otherwise, request `site:<host>` after a fetch returns 403. Use an item only after `request_capability` reports it granted.",
    "The owner decides in a separate trusted surface. Nothing you print to this terminal grants anything.",
    ...notes,
    ...(task.attended ? attendedNote : unattendedNote),
    ...(task.prompt ? ["", "## Owner prompt", "", task.prompt] : []),
  ].join("\n");
};

/** Attended: the owner watches the terminal and answers questions through the ask-user-question extension. */
const attendedNote = [
  "",
  "## Attended task",
  "",
  "The owner is watching this terminal. When only the owner can make a decision that blocks you, ask with `ask_user_question`. Otherwise, keep working without asking.",
];

/** Unattended: nobody answers, so the agent works through the task and records its assumptions instead of asking. */
const unattendedNote = [
  "",
  "## Unattended task",
  "",
  "Nobody is watching this terminal, and nobody will answer questions here. Make reasonable assumptions and record each one in `/output/NOTES.md`.",
  "Do not ask a question and wait. Keep working until the task is complete. Access requests still reach the owner through `request_capability`.",
];

/** The attended-mode extension. It is presence, not access, so it comes from the launch mode instead of a lease. */
export const ASK_USER_EXTENSION = {
  guestPath: "/opt/pi-plugins/rpiv-ask-user-question",
  tools: ["ask_user_question"],
};

/**
 * pi-web-access reads ~/.pi/agent/web-search.json. Search uses only keyless Exa (its hosted MCP endpoint, mcp.exa.ai),
 * and pages are fetched directly over HTTP, so every page host still needs a `site` lease. Hosted extraction services,
 * browser cookies, the curator browser UI, and the video and YouTube paths (Gemini or yt-dlp) are off. The package
 * has no telemetry or network update check; its upgrade notice only compares the bundled changelog.
 */
const webSearchJson = {
  provider: "exa",
  webSearch: { enabled: true, allowedProviders: ["exa"] },
  fetchRouting: { providers: ["http"], allowRemoteHostedProviders: false },
  allowBrowserCookies: false,
  workflow: "none",
  autoOpenBrowser: false,
  toolActivation: "eager",
  commands: { curator: { enabled: false }, "google-account": { enabled: false } },
  youtube: { enabled: false },
  video: { enabled: false },
};

/** Curated servers are small, so Pi declares their tools directly; its default `codemode` exposure hides them behind a tool we do not grant. */
const mcpServers = (catalog: Catalog, ids: string[]) =>
  Object.fromEntries(
    ids.map((id) => {
      const entry = catalog.mcps[id];
      if (!entry) throw new Error(`unknown MCP server ${id}`);
      return [id, { command: entry.command, args: entry.args, description: entry.label, exposure: "direct" }];
    }),
  );

/** Writes the whole trusted guest configuration to a host directory mounted read-only at /etc/bottle-school. */
export const writeGuestConfig = (
  directory: string,
  config: Config,
  catalog: Catalog,
  task: { name: string; model: string; prompt?: string; attended: boolean },
  keys: Map<string, string>,
  leases: Lease[],
  mcpIds: string[],
  extensionIds: string[],
  secrets: SecretInfo[] = [],
) => {
  mkdirSync(`${directory}/extensions`, { recursive: true });
  if (task.prompt) writeFileSync(`${directory}/prompt.md`, task.prompt);
  copyFileSync(
    `${import.meta.dirname}/../guest/extensions/request-capability.ts`,
    `${directory}/extensions/request-capability.ts`,
  );
  // The access-and-creds skill is the one agents use anywhere; it lives with speaker and is mounted unchanged. It is the only skill the guest gets.
  mkdirSync(`${directory}/skills/access-and-creds`, { recursive: true });
  copyFileSync(`${import.meta.dirname}/../../speaker/skill/SKILL.md`, `${directory}/skills/access-and-creds/SKILL.md`);
  const writeJson = (name: string, value: unknown) =>
    writeFileSync(`${directory}/${name}`, JSON.stringify(value, null, 2));
  writeJson("models.json", modelsJson(config, keys));
  writeJson("settings.json", { packages: [], defaultProjectTrust: "never" });
  writeJson("web-search.json", webSearchJson);
  writeFileSync(`${directory}/APPEND_SYSTEM.md`, systemNote(task, leases, catalog, extensionIds, secrets));
  writeJson("mcp.json", { mcpServers: mcpServers(catalog, mcpIds) });

  const [provider, ...model] = task.model.split("/");
  // `--tools` filters MCP tools only when it names them, so each leased tool is listed by its Pi name.
  // Pi replaces every character other than letters, digits, and `_` with `_` in that name.
  const piName = (text: string) => text.replace(/[^A-Za-z0-9_]/g, "_");
  const mcpTools = mcpIds.flatMap((id) =>
    catalog.mcps[id]!.tools.map((tool) => `mcp__${piName(id)}__${piName(tool)}`),
  );
  const extensions = [
    ...(task.attended ? [ASK_USER_EXTENSION] : []),
    ...extensionIds.map((id) => {
      const entry = catalog.extensions[id];
      if (!entry) throw new Error(`unknown extension ${id}`);
      return entry;
    }),
  ];
  const args = [
    "--provider",
    provider,
    "--model",
    model.join("/"),
    "--session",
    SESSION,
    "--tools",
    [BUILT_IN_TOOLS, ...extensions.flatMap((entry) => entry.tools), ...mcpTools].join(","),
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--skill",
    "/etc/bottle-school/skills/access-and-creds",
    "--append-system-prompt",
    "/etc/bottle-school/APPEND_SYSTEM.md",
    "-e",
    "/etc/bottle-school/extensions/request-capability.ts",
    // `--no-extensions` also disables Pi's built-in MCP, so an MCP lease loads it explicitly.
    ...(mcpIds.length ? ["-e", "builtin:mcp"] : []),
    ...extensions.flatMap((entry) => ["-e", entry.guestPath]),
  ];
  writeFileSync(`${directory}/args`, `${args.join("\n")}\n`);
};

type CommandResult = Awaited<ReturnType<Guest["exec"]>>;
const checked = async (operation: string, promise: Promise<CommandResult>) => {
  const result = await promise;
  if (result.exitCode !== 0)
    throw new Error(
      `${operation} failed (${result.exitCode}): ${result.stderr || result.stdout}`.trim(),
    );
  return result;
};

/** Pi runs under dtach in the guest. dtach starts pi-launch; `dtach -p` pushes keystrokes to it. */
const keys = (text: string) => `printf '${text}' | dtach -p /run/pi.dtach`;
/** True while a live pi process exists. A pi that has died stays a zombie (the guest's init never reaps it), so `pgrep` alone would wait forever. */
const alive = "ps -C pi -o stat= | grep -qv '^Z'";
export const pi = {
  start: (guest: Guest) => checked("Pi start", guest.exec("dtach -n /run/pi.dtach /usr/local/bin/pi-launch")),
  abort: (guest: Guest) => guest.exec(keys("\\033")),
  /** Restarting re-reads the regenerated args, and Pi resumes the same task-local session file. */
  restart: (guest: Guest) =>
    checked(
      "Pi restart",
      guest.exec(`pkill -x pi; while ${alive}; do sleep 0.1; done; dtach -n /run/pi.dtach /usr/local/bin/pi-launch`),
    ),
  quit: (guest: Guest) => guest.exec(keys("/quit\\r")),
  running: async (guest: Guest) => (await guest.exec(alive)).exitCode === 0,
  kill: (guest: Guest) => guest.exec("pkill -x pi || true"),
  /** The transcript improves archive browsing, but an exporter failure never discards the session or artifacts. */
  export: (guest: Guest) => guest.exec(`pi --export ${SESSION} /work/transcript.html || true`),
};

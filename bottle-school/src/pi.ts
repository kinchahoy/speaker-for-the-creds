import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Credential } from "./credentials.ts";
import type { Guest } from "./gondolin.ts";
import { unexpired } from "./leases.ts";
import type { Lease } from "./speaker.ts";

const McpBase = z.object({
  label: z.string().min(1),
  tools: z.array(z.string().regex(/^[a-z0-9_-]+$/)).min(1),
  write: z.boolean(),
});
const McpEntry = z.discriminatedUnion("transport", [
  McpBase.extend({
    transport: z.literal("stdio"),
    command: z.string().startsWith("/", "an MCP command is an image-local absolute path"),
    args: z.array(z.string()),
  }).strict(),
  McpBase.extend({
    transport: z.literal("streamable-http"),
    url: z
      .url()
      .refine((value) => new URL(value).protocol === "https:", "a remote MCP server uses https"),
    headers: z.record(z.string(), z.string()).optional(),
    /** Secret whose guest placeholder replaces `${NAME}` in the header values. */
    credential: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "use uppercase letters, digits, and underscores")
      .optional(),
  }).strict(),
]);

export const Catalog = z
  .object({
    mcps: z.record(z.string().regex(/^[a-z0-9-]+$/), McpEntry),
    plugins: z.record(
      z.string().regex(/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/),
      z
        .object({
          label: z.string().min(1),
          guestPath: z.string().startsWith("/", "a plugin lives in the pinned guest image"),
          description: z.string().min(1),
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

/** A remote MCP server authorizes only the endpoint host that its curated catalog entry names. */
export const mcpHosts = (catalog: Catalog, ids: string[]) => [
  ...new Set(
    ids.flatMap((id) => {
      const entry = catalog.mcps[id];
      return entry?.transport === "streamable-http" ? [new URL(entry.url).hostname] : [];
    }),
  ),
];

const SESSION = "/work/.pi-session/task.jsonl";
/** Commands the guest image provides. */
export const CLI_TOOLS = `
  rg fd ast-grep ctags jq yq sqlite3 git gh curl wget tree file shellcheck shfmt
  uv ruff gcc make node tsc go pnpm oxlint oxfmt cmake just pandoc typst
  pdftotext qpdf tesseract magick dot ffmpeg hyperfine delta bat watchexec ty
`.trim().split(/\s+/);
const BUILT_IN_TOOLS = "read,bash,edit,write,grep,find,ls,request_capability";

/** Hosted providers listed in models.json work once a secret lease binds their credential to their host. */
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

const modelsJson = (config: Config, credentials: Map<string, Credential>) => ({
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
          baseUrl: provider.baseUrl,
          api: "openai-completions",
          // Gondolin swaps this placeholder for the real key only in requests to the bound host.
          apiKey: credentials.get(provider.credential)!.placeholder,
          models: modelIds(provider.models),
        },
      ]),
    ),
  },
});

export const systemNote = (
  task: { name: string; prompt?: string },
  leases: Lease[],
  catalog: Catalog,
) => {
  const rows = unexpired(leases).map(
    (lease) =>
      `${lease.kind} ${lease.ref} (${lease.expiresAt ? `expires ${lease.expiresAt}` : "permanent"})`,
  );
  const mcpCatalog =
    Object.entries(catalog.mcps)
      .map(
        ([id, entry]) =>
          `- ${id}: ${entry.label}; tools: ${entry.tools.join(", ")}; ${entry.write ? "can write" : "read-only"}${entry.transport === "streamable-http" ? `; endpoint: ${new URL(entry.url).hostname}` : ""}`,
      )
      .join("\n") || "- none";
  return [
    `# Task: ${task.name}`,
    "",
    "You run inside a disposable micro-VM.",
    "",
    "- `/input` holds host folders the owner leased to you. Each is read-only unless its lease says `:rw`.",
    "- `/work` is your scratch space and holds this session. The owner destroys it when the task closes.",
    "- `/output` is permanent. Write everything the owner should keep there.",
    "- Work directly on the owner's goal and keep updates concise.",
    "- Deliver the simplest working version first. Improve it only when the owner asks.",
    "- Do not read a tool's source code to debug it. Use `--help` or the docs, or try another approach.",
    "- When the owner says stop or wrap up, hand over what exists in that same turn.",
    "- Test each deliverable the way its user will use it, and fix failures before moving on.",
    "- Record assumptions and anything unfinished in `/output/NOTES.md`. Write `/output/DONE` (one line saying what was delivered) only when the whole task is complete and verified; never for partial work. When blocked, say so in `/output/NOTES.md` and in your final reply.",
    "",
    "## Environment",
    "",
    `- CLI tools: ${CLI_TOOLS.join(", ")}.`,
    "- Python: always use uv. Run scratch code with `uv run python` and `uv run pytest`; they use the default environment. For a project, use `uv init`, `uv add`, and `uv run`. No bare `python` or `pip` exists.",
    "- JavaScript work: write TypeScript. Run it with `node file.ts`, check types with `tsc --noEmit`, manage packages with pnpm, lint with `oxlint`, and format with `oxfmt`.",
    "- Go work: use `go mod init`, `go build`, and `go test`. Module downloads need `proxy.golang.org` and `sum.golang.org`.",
    "- Browser automation: some images include Python Playwright with headless Chromium. Check with `command -v playwright`.",
    "- To get a missing tool or library, install it from a package registry: `uv add` (PyPI) or `pnpm add` (npm). Many CLI tools ship there. Request direct binary downloads (such as GitHub releases) only when no registry package exists.",
    "- Hosts to request as `site` leases: PyPI `pypi.org`, `files.pythonhosted.org`; npm `registry.npmjs.org`; git clone `github.com`, `codeload.github.com`; GitHub raw `raw.githubusercontent.com`; GitHub releases `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com`; Hugging Face `huggingface.co`, `cdn-lfs.huggingface.co`, `cas-bridge.xethub.hf.co`; Rust `crates.io`, `index.crates.io`, `static.crates.io`; Go `proxy.golang.org`, `sum.golang.org`. For any other site request the exact hostnames the tool contacts, and check redirects. Prefer a named bundle when the owner offers one.",
    "- For homelab APIs, HTTP MCP servers, and every other lease kind, follow the `access-and-creds` skill.",
    "",
    "## Leases at this Pi start",
    "",
    ...(rows.length ? rows.map((row) => `- ${row}`) : ["- none"]),
    "",
    "A lease ends at its expiry time. After expiry, requests to it return 403 until the owner approves a new one.",
    "A denied HTTP request returns 403. Treat the current request result as authoritative because the owner can change leases while you run.",
    "When a lease blocks required work, call `request_capability` once with a `kind` and a `ref`, or with a `bundle`. It waits for the owner's decision and returns the result; continue independent work meanwhile.",
    "- `site`: a hostname such as `pypi.org`, or `*.example.com`. Request several hostnames with one call each.",
    "- `secret`: `NAME@host[,host]`, to let a host-held credential reach those hosts.",
    "- `folder`: a share name for read-only access, or `<share>:rw` for write access. It appears under `/input/<share>`.",
    "- `mcp`: an exact catalog ID. A new MCP server starts after Pi restarts at idle.",
    "",
    "## Available MCP catalog",
    "",
    mcpCatalog,
    "Example: request site `www.google.com` after `curl https://www.google.com` returns 403. Retry only after `request_capability` reports approval.",
    "The owner decides in a separate trusted surface. Nothing you print to this terminal grants anything.",
    ...(task.prompt ? oneShotNote(task.prompt) : []),
  ].join("\n");
};

/** A launch prompt is the whole assignment. The owner is away, so the agent works through it without asking. */
const oneShotNote = (prompt: string) => [
  "",
  "## One-shot task",
  "",
  "The owner is away and will not answer questions. Make reasonable assumptions and record each one in `/output/NOTES.md`.",
  "Do not ask questions and wait. Keep working until the task is complete.",
  "Write `/output/DONE` only when the whole task is complete and verified. Its one line says what was delivered.",
  "",
  "Owner prompt:",
  "",
  prompt,
];

/** Curated servers are small, so Pi declares their tools directly; its default `codemode` exposure hides them behind a tool we do not grant. Pi reads remote MCP headers from mcp.json; Gondolin swaps each placeholder for the real secret at its bound host. */
const mcpServers = (catalog: Catalog, ids: string[], credentials: Map<string, Credential>) =>
  Object.fromEntries(
    ids.map((id) => {
      const entry = catalog.mcps[id];
      if (!entry) throw new Error(`unknown MCP server ${id}`);
      const common = { description: entry.label, exposure: "direct" };
      if (entry.transport === "stdio")
        return [id, { command: entry.command, args: entry.args, ...common }];
      const headers = Object.fromEntries(
        Object.entries(entry.headers ?? {}).map(([name, value]) => {
          if (!entry.credential) return [name, value];
          const credential = credentials.get(entry.credential);
          if (!credential)
            throw new Error(
              `MCP server ${id} needs secret ${entry.credential}, which is not configured`,
            );
          return [name, value.replaceAll(`\${${entry.credential}}`, credential.placeholder)];
        }),
      );
      return [id, { url: entry.url, headers, ...common }];
    }),
  );

/** Writes the whole trusted guest configuration to a host directory mounted read-only at /etc/pi-v2. */
export const writeGuestConfig = (
  directory: string,
  config: Config,
  catalog: Catalog,
  task: { name: string; model: string; prompt?: string },
  credentials: Map<string, Credential>,
  leases: Lease[],
  mcpIds: string[],
  pluginIds: string[],
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
  writeJson("models.json", modelsJson(config, credentials));
  writeJson("settings.json", { packages: [], defaultProjectTrust: "never" });
  writeFileSync(`${directory}/APPEND_SYSTEM.md`, systemNote(task, leases, catalog));
  writeJson("mcp.json", { mcpServers: mcpServers(catalog, mcpIds, credentials) });

  const [provider, ...model] = task.model.split("/");
  // `--tools` filters MCP tools only when it names them, so each leased tool is listed by its Pi name.
  // Pi replaces every character other than letters, digits, and `_` with `_` in that name.
  const piName = (text: string) => text.replace(/[^A-Za-z0-9_]/g, "_");
  const mcpTools = mcpIds.flatMap((id) =>
    catalog.mcps[id]!.tools.map((tool) => `mcp__${piName(id)}__${piName(tool)}`),
  );
  const plugins = pluginIds
    .map((id) => catalog.plugins[id]?.guestPath)
    .filter(Boolean) as string[];
  const args = [
    "--provider",
    provider,
    "--model",
    model.join("/"),
    "--session",
    SESSION,
    "--tools",
    [BUILT_IN_TOOLS, ...mcpTools].join(","),
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--skill",
    "/etc/pi-v2/skills/access-and-creds",
    "--append-system-prompt",
    "/etc/pi-v2/APPEND_SYSTEM.md",
    "-e",
    "/etc/pi-v2/extensions/request-capability.ts",
    // `--no-extensions` also disables Pi's built-in MCP, so an MCP lease loads it explicitly.
    ...(mcpIds.length ? ["-e", "builtin:mcp"] : []),
    ...plugins.flatMap((path) => ["-e", path]),
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
export const pi = {
  start: (guest: Guest) => checked("Pi start", guest.exec("dtach -n /run/pi.dtach /usr/local/bin/pi-launch")),
  abort: (guest: Guest) => guest.exec(keys("\\033")),
  /** Restarting re-reads the regenerated args, and Pi resumes the same task-local session file. */
  restart: (guest: Guest) =>
    checked(
      "Pi restart",
      guest.exec("pkill -x pi; while pgrep -x pi >/dev/null; do sleep 0.1; done; dtach -n /run/pi.dtach /usr/local/bin/pi-launch"),
    ),
  quit: (guest: Guest) => guest.exec(keys("/quit\\r")),
  running: async (guest: Guest) => (await guest.exec("pgrep -x pi")).exitCode === 0,
  kill: (guest: Guest) => guest.exec("pkill -x pi || true"),
  /** The transcript improves archive browsing, but an exporter failure never discards the session or artifacts. */
  export: (guest: Guest) => guest.exec(`pi --export ${SESSION} /work/transcript.html || true`),
};

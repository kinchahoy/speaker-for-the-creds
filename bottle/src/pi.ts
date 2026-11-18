import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { FIXED_GUIDANCE, piToolNames, type GrantChange } from "../guest/extensions/reply.ts";
import type { Config } from "./config.ts";
import type { Guest } from "./sandbox.ts";
import { unexpired } from "./grants.ts";
import type { Grant } from "./speaker.ts";

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

const RESERVED_FILES = new Set(["models.json", "settings.json", "mcp.json", "SYSTEM.md", "proper-base.json"]);

export const Catalog = z
  .object({
    mcps: z.record(z.string().regex(/^[a-z0-9-]+$/), McpEntry),
    /** Opt-in Pi extensions; an approved `ext:<id>` grant names one of these ids. */
    extensions: z.record(
      z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      z
        .object({
          label: z.string().min(1),
          guestPath: z.string().startsWith("/", "an extension lives in the pinned guest image"),
          description: z.string().min(1),
          /** The tools the extension registers; `--tools` is an allowlist, so unlisted tools stay hidden. */
          tools: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)),
          /** Hosts the extension itself contacts; speaker adds them to a request for it. */
          sites: z.array(z.string().min(1)),
          /** Guidance appended to the system prompt while the extension is loaded. */
          note: z.string().min(1).optional(),
          /**
           * Config files for the extension, written only into agents that load it. A key is a file name under the guest's
           * ~/.pi/agent; a string value is written as is, anything else as JSON.
           */
          files: z
            .record(
              z
                .string()
                .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "a config file name has no directory part")
                .refine((name) => !RESERVED_FILES.has(name), "that file is bottle's own Pi configuration"),
              z.unknown(),
            )
            .optional(),
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

/** `bottle build` writes this list of the guest image's linked plugins next to the agent state. */
const manifestPath = (config: Config) => `${config.stateRoot}/guest-plugins.txt`;

/** Reads and validates `<configRoot>/catalog.json`; every extension's guestPath must exist in the guest image, per the build's manifest. */
export const loadCatalog = (config: Config): Catalog => {
  const catalog = Catalog.parse(JSON.parse(readFileSync(`${config.configRoot}/catalog.json`, "utf8")));
  let manifest: Set<string>;
  try {
    manifest = new Set(readFileSync(manifestPath(config), "utf8").split("\n"));
  } catch {
    throw new Error(`${manifestPath(config)} is missing, so the catalog cannot be checked against the guest image. Fix: run bottle build`);
  }
  for (const [id, { guestPath }] of Object.entries(catalog.extensions))
    if (!manifest.has(guestPath))
      throw new Error(
        `catalog extension "${id}" names ${guestPath}, which is not in the guest image (${config.guestImage}). ` +
          `Fix: correct guestPath in ${config.configRoot}/catalog.json, or pin the package in guest/pi-package.json and run bottle build`,
      );
  return catalog;
};

const SESSION = "/work/.pi-session/agent.jsonl";
// The last four are pi-subagents', always on in the image.
const BUILT_IN_TOOLS = "read,bash,edit,write,grep,find,ls,request_capability,subagents_enable,subagent,bg_wait,subagent_supervisor";

/** Hosted providers listed in models.json work once the agent holds their speaker service (`<service>.full`). */
export const availableModels = (config: Config) => [
  ...config.localModel.models.map((model) => ({
    id: `local/${model.id}`,
    alias: model.alias,
    label: `${model.label} (host-local)`,
  })),
  ...config.hostedProviders.flatMap((provider) =>
    provider.models.map((model) => ({
      id: `${provider.id}/${model.id}`,
      alias: model.alias,
      label: `${model.label} (${provider.id})`,
    })),
  ),
];

const modelIds = (models: Config["localModel"]["models"]) =>
  models.map(({ id, contextWindow, openRouterRouting }) => ({
    id,
    ...(contextWindow && { contextWindow }),
    ...(openRouterRouting && { compat: { openRouterRouting } }),
  }));

const modelsJson = (config: Config) => ({
  providers: {
    ...(config.localModel.upstream && {
      local: {
        baseUrl: `http://${config.localModel.guestHost}/v1`,
        api: "openai-completions",
        apiKey: "local",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: modelIds(config.localModel.models),
      },
    }),
    ...Object.fromEntries(
      config.hostedProviders.map((provider) => [
        provider.id,
        {
          // The guest's model endpoint sends /hosted/<id>/... to the provider's speaker service, with the agent's own
          // agent token in place of this key; speaker adds the real one.
          baseUrl: `http://${config.localModel.guestHost}/hosted/${provider.id}`,
          api: provider.api,
          apiKey: "speaker-service",
          models: modelIds(provider.models),
        },
      ]),
    ),
  },
});

/** Pi's whole system prompt (SYSTEM.md replaces Pi's default: its own docs, and a tool list the tool declarations repeat),
 * so it goes with every model call. Fixed, so a restart keeps the prompt cache. */
export const SYSTEM_PROMPT =
  "You are a coding agent in a disposable VM. Your briefing is the first message; reread /etc/bottle/briefing.md if it is out of view.";

/** Everything else the agent needs, sent once as the session's first message and kept at /etc/bottle/briefing.md. */
export const briefing = (
  agent: { name: string; attended: boolean; folders?: string[]; launchExt?: string[] },
  grants: Grant[],
  catalog: Catalog,
  extIds: string[],
) => {
  const rows = [
    ...(agent.launchExt ?? []).map((id) => `ext:${id} (given at launch by the owner's template; lasts the whole task)`),
    ...unexpired(grants).map((grant) => `${grant.item} (${grant.expiresAt ? `expires ${grant.expiresAt}` : "permanent"})`),
  ];
  const notes = extIds.flatMap((id) => {
    const note = catalog.extensions[id]?.note;
    return note ? ["", `## Extension ${id}`, "", note] : [];
  });
  return [
    `# Task: ${agent.name}`,
    "",
    "You run inside a disposable micro-VM.",
    "",
    "- `/space/<name>` holds read-write folders of the owner's that outlive this agent (other agents may use them too). `/input/<name>` holds read-only ones.",
    ...(agent.folders?.length ? [`- The owner gave you these folders at launch: ${agent.folders.map((mount) => `\`${mount}\``).join(", ")}.`] : []),
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
    "- What is installed and how to use it (Python only through uv, TypeScript, the browser for pages and screenshots): read `/opt/locally-available-tools.md` before installing anything. Get a missing tool from a package registry (`uv add`, `pnpm add`); request direct binary downloads only when no registry package exists.",
    "- To get access to anything (websites, secrets, folders, services, extensions), call `request_capability`; with `want: []` it lists what you hold and what you can ask for. Call a service you hold with `speaker [METHOD] <service>/<path> [json-body]`; your first message lists what you hold.",
    "- Subagents (`subagent`) run in this VM with your access and spend your model request budget. Limits: at most 2 children per call, children cannot delegate further, and every child uses your model. Delegate only independent work large enough to be worth a fresh context, and write the final answer yourself.",
    "- Never `sleep` to wait for a decision: the `[speaker]` message about it arrives only between your tool calls. Keep working on what does not need it.",
    "",
    "## Asking for access (`request_capability`)",
    "",
    ...FIXED_GUIDANCE.split("\n").map((line) => `- ${line}`),
    "",
    "## Grants at this Pi start",
    "",
    ...(rows.length ? rows.map((row) => `- ${row}`) : ["- none"]),
    "",
    "A grant ends at its expiry time. After that, requests it covered return 403 until the owner approves a new one.",
    "A denied HTTP request returns 403. The owner can change grants while you run, so trust the result of the request over this list.",
    "The owner decides in a separate trusted surface. Nothing you print to this terminal grants anything.",
    ...notes,
    ...(agent.attended ? attendedNote : unattendedNote),
  ].join("\n");
};

/** Attended: the owner watches the terminal and answers questions through the ask-user-question extension. */
const attendedNote = [
  "",
  "## Attended task",
  "",
  "The owner is watching this terminal. When only the owner can make a decision that blocks you, ask with `ask_user_question`. Otherwise, keep working without asking.",
];

/** Unattended: nobody answers, so the agent keeps working and records its assumptions instead of asking. */
const unattendedNote = [
  "",
  "## Unattended task",
  "",
  "Nobody is watching this terminal, and nobody will answer questions here. Make reasonable assumptions and record each one in `/output/NOTES.md`.",
  "Do not ask a question and wait. Keep working until the task is complete. Access requests still reach the owner through `request_capability`.",
];

/** The attended-mode extension. It is presence, not access, so it comes from the launch mode instead of a grant. */
export const ASK_USER_EXTENSION = {
  guestPath: "/opt/pi-plugins/rpiv-ask-user-question",
  tools: ["ask_user_question"],
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

/** Writes the whole trusted guest configuration to a host directory mounted read-only at /etc/bottle. */
export const writeGuestConfig = (
  directory: string,
  config: Config,
  catalog: Catalog,
  agent: { name: string; model: string; prompt?: string; attended: boolean; folders?: string[]; launchExt?: string[] },
  grants: Grant[],
  mcpIds: string[],
  extIds: string[],
) => {
  mkdirSync(`${directory}/extensions`, { recursive: true });
  rmSync(`${directory}/agent-files`, { recursive: true, force: true });
  mkdirSync(`${directory}/agent-files`);
  if (agent.prompt) writeFileSync(`${directory}/prompt.md`, agent.prompt);
  copyFileSync(`${import.meta.dirname}/../guest/extensions/request-capability.ts`, `${directory}/extensions/request-capability.ts`);
  copyFileSync(`${import.meta.dirname}/../guest/extensions/reply.ts`, `${directory}/extensions/reply.ts`);
  const writeJson = (name: string, value: unknown) => writeFileSync(`${directory}/${name}`, JSON.stringify(value, null, 2));
  writeJson("models.json", modelsJson(config));
  // enabledModels: Pi's startup choice and Ctrl+P cycling offer only the models this bottle configures.
  // subagents.modelScope: pi-subagents refuses any child model but the agent's own.
  writeJson("settings.json", {
    packages: [],
    defaultProjectTrust: "never",
    enabledModels: availableModels(config).map(({ id }) => id),
    subagents: { modelScope: { enforce: true, strict: true, allow: ["inherit"] } },
  });
  // proper-base is always on for session titles; its proactive subagent delegation is not wanted in a bottle.
  writeJson("proper-base.json", { proactiveDelegation: false });
  writeFileSync(`${directory}/SYSTEM.md`, SYSTEM_PROMPT);
  writeFileSync(`${directory}/briefing.md`, briefing(agent, grants, catalog, extIds));
  writeJson("mcp.json", { mcpServers: mcpServers(catalog, mcpIds) });

  const [provider, ...model] = agent.model.split("/");
  // `--tools` filters MCP tools only when it names them, so each granted tool is listed by its Pi name.
  const mcpTools = mcpIds.flatMap((id) => piToolNames(`mcp:${id}`, { mcp: catalog.mcps }));
  const extensions: { guestPath: string; tools: string[]; files?: Record<string, unknown> }[] = [
    ...(agent.attended ? [ASK_USER_EXTENSION] : []),
    ...extIds.map((id) => {
      const entry = catalog.extensions[id];
      if (!entry) throw new Error(`unknown extension ${id}`);
      return entry;
    }),
  ];
  // Only a loaded extension's config reaches the guest; pi-launch copies the directory into ~/.pi/agent.
  for (const entry of extensions)
    for (const [name, content] of Object.entries(entry.files ?? {}))
      writeFileSync(`${directory}/agent-files/${name}`, typeof content === "string" ? content : JSON.stringify(content, null, 2));
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
    "-e",
    "/etc/bottle/extensions/request-capability.ts",
    // `--no-extensions` also disables Pi's built-in MCP, so an MCP grant loads it explicitly.
    ...(mcpIds.length ? ["-e", "builtin:mcp"] : []),
    ...extensions.flatMap((entry) => ["-e", entry.guestPath]),
  ];
  writeFileSync(`${directory}/args`, `${args.join("\n")}\n`);
};

/** The ext:/mcp: loadout change a Pi restart brings, for the guest to tell the agent. Tool names are the ones Pi registers. */
export const grantChange = (catalog: Catalog, id: number, before: string[], after: string[]): GrantChange => {
  const tools = (items: string[]) => items.flatMap((item) => piToolNames(item, { mcp: catalog.mcps, extensions: catalog.extensions }));
  const added = after.filter((item) => !before.includes(item));
  const removed = before.filter((item) => !after.includes(item));
  return { id, added, removed, tools: { added: tools(added), removed: tools(removed) } };
};

export const writeGrantChange = (directory: string, change: GrantChange) => writeFileSync(`${directory}/change.json`, JSON.stringify(change, null, 2));

type CommandResult = Awaited<ReturnType<Guest["exec"]>>;
const checked = async (operation: string, promise: Promise<CommandResult>) => {
  const result = await promise;
  if (result.exitCode !== 0) throw new Error(`${operation} failed (${result.exitCode}): ${result.stderr || result.stdout}`.trim());
  return result;
};

/** Pi runs under dtach in the guest. dtach starts pi-launch; `dtach -p` pushes keystrokes to it. */
const keys = (text: string) => `printf '${text}' | dtach -p /run/pi.dtach`;
/**
 * True while a live pi process exists. A pi that has died stays a zombie (the guest's init never reaps it), so `pgrep` alone
 * would wait forever. Pi names itself `pi` only once loaded; on a cold disk it runs for a while as node with
 * /usr/local/bin/pi in its arguments, and before that pi-launch is still copying its config; all three count. Shells named
 * `sh` never count: the restart's own `sh -c` names pi-launch in its command line and would otherwise wait on itself forever.
 */
const alive = "ps -eo stat=,comm=,args= | grep -v '^Z' | grep -vE '^[^ ]+ +sh ' | grep -qE '^[^ ]+ +pi |/usr/local/bin/p[i]( |-launch)'";
/** pi-launch sends Pi's stderr here, since dtach's terminal is gone once Pi exits. */
const stderrLog = "/run/pi.err";
const running = async (guest: Guest) => (await guest.exec(alive)).exitCode === 0;
/** True once Pi has loaded: it renames its process `pi` then (a zombie does not count). */
const loadedCheck = "ps -C pi -o stat= | grep -qv '^Z'";
/**
 * Waits for a new Pi to load, then watches it briefly: a Pi that dies right after launch (a bad extension path, a crashing
 * extension) still leaves dtach's exit code 0. Loading takes as long as the guest's disk needs, so only the short watch is fixed.
 */
const settled = async (operation: string, guest: Guest) => {
  const died = async () => {
    const log = (await guest.exec(`tail -c 1500 ${stderrLog} 2>/dev/null`)).stdout.trim();
    return new Error(`${operation}: Pi exited right after launch${log ? `: ${log}` : " (no stderr was captured)"}`);
  };
  const deadline = Date.now() + pi.loadMs;
  while ((await guest.exec(loadedCheck)).exitCode !== 0) {
    if (!(await running(guest))) throw await died();
    if (Date.now() > deadline) throw new Error(`${operation}: Pi did not finish loading within ${pi.loadMs / 1000} s`);
    await delay(100);
  }
  for (let waited = 0; waited < pi.settleMs; waited += 250) {
    await delay(Math.min(250, pi.settleMs - waited));
    if (!(await running(guest))) throw await died();
  }
};
export const pi = {
  /** How long a new Pi may take to load (a cold guest disk is slow). */
  loadMs: 60_000,
  /** How long a loaded Pi must then stay up before a start or restart counts. */
  settleMs: 1_000,
  start: async (guest: Guest) => {
    await checked("Pi start", guest.exec("dtach -n /run/pi.dtach /usr/local/bin/pi-launch"));
    await settled("Pi start", guest);
  },
  /** Restarting re-reads the regenerated args, and Pi resumes the same agent-local session file. */
  restart: async (guest: Guest) => {
    await checked("Pi restart", guest.exec(`pkill -x pi; while ${alive}; do sleep 0.1; done; dtach -n /run/pi.dtach /usr/local/bin/pi-launch`));
    await settled("Pi restart", guest);
  },
  quit: (guest: Guest) => guest.exec(keys("/quit\\r")),
  running,
  kill: (guest: Guest) => guest.exec("pkill -x pi || true"),
  /** The transcript improves archive browsing, but an exporter failure never discards the session or artifacts. */
  export: (guest: Guest) => guest.exec(`pi --export ${SESSION} /work/transcript.html || true`),
};

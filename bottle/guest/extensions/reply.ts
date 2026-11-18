// Pure text for request_capability: its description and the reply after the owner decides. No Pi imports, so host tests load it.

/** The part of GET /_speaker/catalog the texts read. */
type State = { state: string; until?: string | null };
export type CatalogView = {
  secrets?: Record<string, { state?: string; hosts: string[]; environment?: Record<string, string>; git?: string; release?: unknown }>;
  services?: Record<string, { mcp?: boolean; read?: State; full?: State }>;
  groups?: Record<string, { items: string[] }>;
  ssh?: { item: string; commands: string[] }[];
  grants?: { item: string; applying?: boolean }[];
  extensions?: Record<string, { tools: string[]; state?: string }>;
  mcp?: Record<string, { tools: string[]; state?: string }>;
};
/** The part of POST /_speaker/requests the reply reads. */
export type Decision = { status: string; granted?: string[]; applying?: string[]; denied?: string[]; expiresAt?: string };

export const FIXED_GUIDANCE = [
  "Ask the owner for access you do not have: a website, secret, folder, SSH target, service, or extension. The owner approves or denies; you cannot grant yourself anything.",
  "Put every item you need in one call. The owner approves the items together in one decision, so several calls make the owner decide several times.",
  "If a website returns 403, ask for `site:<that hostname>` and retry after it is granted.",
  "Folder and SSH target names come from your task or from the owner. Do not guess them.",
  "The call does not wait. If the owner has not decided yet it replies at once that the request is filed. Keep working on anything that does not need it, and do not ask again for the same items.",
  "When the owner decides, you get a message starting `[speaker]` with one line per item saying what to do next. Do what the line says. A request can stay open for hours.",
].join("\n");

/** Fixed text, so the model's prompt cache survives grant changes. The lists below come back when `want` is empty. */
export const toolDescription = `${FIXED_GUIDANCE}\n\nCall with an empty \`want\` list to see what you hold and what you can ask for (a site is asked for as site:<hostname>).`;

/** One line per thing the agent holds, each with the exact way to use it. */
export const accessBlock = (catalog: CatalogView) => {
  const rows: string[][] = [
    ...Object.entries(catalog.services ?? {}).flatMap(([name, { mcp, read, full }]) => {
      const rw = full?.state === "granted";
      if (!rw && read?.state !== "granted") return [];
      return [
        [
          name,
          rw ? "rw" : "r",
          mcp ? `MCP: POST $SPEAKER_URL/${name} (JSON-RPC)` : `speaker ${rw ? "<METHOD> " : ""}${name}/<path>${rw ? " [json-body]" : ""}`,
        ],
      ];
    }),
    ...(catalog.grants ?? []).flatMap(({ item }) => {
      const [kind, ref, mode] = item.split(":");
      if (kind === "site") return [[ref!, "site", "use it directly"]];
      if (kind === "folder") return [[`/${mode === "rw" ? "space" : "input"}/${ref}`, mode === "rw" ? "rw" : "r", "folder"]];
      if (kind === "ext" || kind === "mcp") return [[item, "tools", (kind === "ext" ? catalog.extensions : catalog.mcp)?.[ref!]?.tools.join(", ") ?? ""]];
      return [];
    }),
    ...(catalog.ssh ?? []).map(({ item, commands }) => [item, "ssh", commands[0] ?? ""]),
    ...Object.entries(catalog.secrets ?? {}).flatMap(([name, secret]) => {
      if (secret.state !== "granted") return [];
      const [variable, value] = Object.entries(secret.environment ?? {})[0] ?? [];
      return [
        [
          `secret:${name}`,
          "secret",
          secret.release ? `curl -s $SPEAKER_URL/_speaker/secrets/${name}` : `${variable}=${value} <command> (only for ${secret.hosts.join(", ")})`,
        ],
      ];
    }),
  ];
  const width = Math.max(0, ...rows.map(([name]) => name!.length));
  return [
    "What you hold (call exactly as shown):",
    ...(rows.length ? rows.map(([name, mode, how]) => `${name!.padEnd(width)}  ${mode!.padEnd(6)}  ${how}`) : ["nothing yet"]),
    "Anything else: ask with request_capability, never by calling a service not listed here.",
  ].join("\n");
};

/** What can still be asked for, one line each with its state. */
export const askList = (catalog: CatalogView) =>
  [
    ...Object.entries(catalog.services ?? {}).flatMap(([name, { read, full }]) =>
      (
        [
          [`${name}.read`, read],
          [`${name}.full`, full],
        ] as const
      ).flatMap(([item, state]) => (state && state.state !== "granted" ? [`${item} ${state.state}`] : [])),
    ),
    ...Object.entries(catalog.secrets ?? {})
      .filter(([, secret]) => secret.state !== "granted")
      .map(([name]) => `secret:${name} ask`),
    ...Object.entries(catalog.groups ?? {}).map(([name, group]) => `group:${name} ask: ${group.items.join(", ")}`),
    ...Object.entries(catalog.extensions ?? {})
      .filter(([, entry]) => entry.state !== "granted")
      .map(([name]) => `ext:${name} ask`),
    ...Object.entries(catalog.mcp ?? {})
      .filter(([, entry]) => entry.state !== "granted")
      .map(([name]) => `mcp:${name} ask`),
  ].join("\n") || "nothing more to ask for";

const until = (iso: string | undefined, now = Date.now()) => {
  if (!iso) return "";
  const date = new Date(iso);
  const stamp = date.toISOString();
  return ` until ${date.getTime() - now > 20 * 3_600_000 ? `${stamp.slice(0, 10)} ` : ""}${stamp.slice(11, 16)} UTC`;
};

/** Items only a Pi restart can bring in force. */
export const needsRestart = (item: string) => item.startsWith("ext:") || item.startsWith("mcp:");

/** Pi's name for an MCP tool; ext tools keep their own names. */
export const piToolNames = (item: string, catalog: CatalogView) => {
  const kind = item.slice(0, item.indexOf(":"));
  const id = item.slice(item.indexOf(":") + 1);
  const piName = (text: string) => text.replace(/[^A-Za-z0-9_]/g, "_");
  if (kind === "ext") return catalog.extensions?.[id]?.tools ?? [];
  if (kind === "mcp") return (catalog.mcp?.[id]?.tools ?? []).map((tool) => `mcp__${piName(id)}__${piName(tool)}`);
  return [];
};

/** What changed in Pi's ext:/mcp: loadout at a restart, written by bottle to /etc/bottle/change.json. `id` rises with each change. */
export type GrantChange = { id: number; added: string[]; removed: string[]; tools: { added: string[]; removed: string[] } };

/** The one message the agent gets after a restart: what loaded, what did not (`active` is Pi's active tool list), and what is gone. */
export const changeMessage = (change: GrantChange, active: string[]) => {
  const present = new Set(active);
  const loaded = change.tools.added.filter((name) => present.has(name));
  const missing = change.tools.added.filter((name) => !present.has(name));
  const gone = [...change.removed, ...change.tools.removed];
  return [
    "Pi restarted because your grants changed.",
    ...(change.added.length ? [`Now available: ${loaded.join(", ") || "no new tools"} (from ${change.added.join(", ")}).`] : []),
    ...(missing.length ? [`These did not load: ${missing.join(", ")}.`] : []),
    ...(gone.length ? [`Removed, do not use: ${gone.join(", ")}.`] : []),
    "Continue the task.",
  ].join(" ");
};

/** One line for a granted item. `help` is the service notes from GET /_speaker/help/<service>, if any. */
export const grantedLine = (item: string, catalog: CatalogView, expiresAt?: string, help = "") => {
  const head = `Granted: ${item}${until(expiresAt)}`;
  if (item.startsWith("site:")) return `${head}. Requests to ${item.slice(5)} now go through. Retry what failed.`;
  if (item.startsWith("secret:")) {
    const secret = catalog.secrets?.[item.slice(7)];
    if (!secret) throw new Error(`speaker's catalog does not show ${item} as granted`);
    const [name, value] = Object.entries(secret.environment ?? {})[0] ?? [];
    if (!name || !value) throw new Error(`speaker's catalog gives no variable for ${item}`);
    return (
      `${head}. Put ${name}=${value} in front of the one command that needs it, for example: ${name}=${value} <command>. ` +
      `That value is a stand-in: speaker swaps in the real token when the request leaves, and only for ${secret.hosts.join(" and ")}. ` +
      `Do not print it or save it to a file.${secret.git ? ` ${secret.git}` : ""}`
    );
  }
  if (item.startsWith("folder:")) {
    const [, share, mode] = item.split(":");
    return mode === "rw"
      ? `Granted: folder:${share}, read-write${until(expiresAt)}. Its files are in /space/${share}. You can write there.`
      : `Granted: folder:${share}, read-only${until(expiresAt)}. Its files are in /input/${share}. You cannot write there; put results in /output.`;
  }
  if (item.startsWith("ssh:")) {
    const commands = catalog.ssh?.find((entry) => entry.item === item)?.commands ?? [];
    return `${head}. Run commands like this: ${commands[0] ?? "(speaker gave no command line)"}`;
  }
  if (needsRestart(item)) {
    const tools = piToolNames(item, catalog).join(", ") || "its tools";
    return (
      `${head}. Its tools (${tools}) load the next time you pause; you will get a message when they are available. ` +
      "Keep working on anything that does not need them."
    );
  }
  if (/\.(read|full)$/.test(item)) {
    const service = item.replace(/\.(read|full)$/, "");
    const how = catalog.services?.[service]?.mcp
      ? `It is an MCP server. Send JSON-RPC with POST to $SPEAKER_URL/${service}: first initialize, then tools/list, then tools/call.`
      : `Call it like this: speaker <METHOD> ${service}/<path> [json-body]`;
    return `${head}. ${how}${help ? ` Notes from the service: ${help}` : ""}`;
  }
  return `${head}.`;
};

export const deniedLine = (item: string) =>
  `Denied: ${item}. Do not ask for it again in this task. Do the work without it. If you can't, write what you could not do, and why, in /output/NOTES.md.`;

/** Items in a request, as a stable key: the same set asked in any order is the same request. */
export const pendingKey = (want: string[]) => [...new Set(want)].sort().join(" ");

/** What the tool answers when speaker has not decided yet. */
export const filedText = (id: number | string) =>
  `Filed as request ${id}. Not decided yet. Keep working on anything that doesn't need it; you will get a message starting \`[speaker]\` when it is decided. Don't ask again for the same items.`;

/** What the tool answers when these items are already waiting for the owner. */
export const alreadyPendingText = (id: number | string) =>
  `Already pending as request ${id}. Not decided yet. Keep working on anything that doesn't need it; you will get a message starting \`[speaker]\` when it is decided. Don't ask again for the same items.`;

export const reply = (decision: Decision, catalog: CatalogView, help: Record<string, string> = {}) =>
  [
    ...(decision.granted ?? []).map((item) => grantedLine(item, catalog, decision.expiresAt, help[item.replace(/\.(read|full)$/, "")])),
    ...(decision.denied ?? []).map(deniedLine),
  ].join("\n") || "The owner answered but granted and denied nothing. Work without it.";

/** The one message the agent gets when a filed request is decided (`want` is what it asked for). */
export const decisionMessage = (decision: Decision, want: string[], catalog: CatalogView, help: Record<string, string> = {}) =>
  decision.status === "expired"
    ? `[speaker] The owner did not decide on ${want.join(", ")}. Ask again only if you still need it.`
    : `[speaker] ${reply(decision, catalog, help)}\n\n${accessBlock(catalog)}`;

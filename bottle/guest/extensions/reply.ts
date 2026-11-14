// Pure text for request_capability: its description and the reply after the owner decides. No Pi imports, so host tests load it.

/** The part of GET /_speaker/catalog the reply reads. */
export type CatalogView = {
  text?: string;
  secrets?: Record<string, { hosts: string[]; env?: string; placeholder?: string; environment?: Record<string, string>; git?: string }>;
  services?: Record<string, { mcp?: boolean }>;
  ssh?: { item: string; commands: string[] }[];
  grants?: { item: string; applying?: boolean }[];
  extensions?: Record<string, { tools: string[] }>;
  mcp?: Record<string, { tools: string[] }>;
};
/** The part of POST /_speaker/requests the reply reads. */
export type Decision = { status: string; granted?: string[]; applying?: string[]; denied?: string[]; expiresAt?: string };

export const FIXED_GUIDANCE = [
  "Ask the owner for access you do not have: a website, secret, folder, SSH target, service, or extension. The owner approves or denies; you cannot grant yourself anything.",
  "Put every item you need in one call. The owner approves the items together in one decision, so several calls make the owner decide several times.",
  "If a website returns 403, ask for `site:<that hostname>` and retry after it is granted.",
  "Folder and SSH target names come from your task or from the owner. Do not guess them.",
  "The call waits for the decision, up to 30 minutes, then replies with one line per item saying what to do next. Do what the line says.",
].join("\n");

export const toolDescription = (catalogText: string) => `${FIXED_GUIDANCE}\n\nWhat you can ask for right now:\n${catalogText}`;

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
    const [name, value] = Object.entries(secret.environment ?? {})[0] ?? [secret.env, secret.placeholder];
    if (!name || !value) throw new Error(`speaker's catalog gives no variable or placeholder for ${item}`);
    return (
      `${head}. Put ${name}=${value} in front of the one command that needs it, for example: ${name}=${value} <command>. ` +
      `That value is a stand-in: speaker swaps in the real token when the request leaves, and only for ${secret.hosts.join(" and ")}. ` +
      `Do not print it or save it to a file.${secret.git ? ` ${secret.git}` : ""}`
    );
  }
  if (item.startsWith("folder:")) {
    const [, share, mode] = item.split(":");
    return mode === "rw"
      ? `Granted: folder:${share}, read-write${until(expiresAt)}. Its files are in /input/${share}. You can write there.`
      : `Granted: folder:${share}, read-only${until(expiresAt)}. Its files are in /input/${share}. You cannot write there; put results in /output.`;
  }
  if (item.startsWith("ssh:")) {
    const commands = catalog.ssh?.find((entry) => entry.item === item)?.commands ?? [];
    return `${head}. Run commands like this: ${commands[0] ?? "(speaker gave no command line)"}`;
  }
  if (needsRestart(item)) {
    const tools = piToolNames(item, catalog).join(", ") || "its tools";
    return (
      `${head}. Its tools (${tools}) are not loaded yet. They load when Pi restarts, and Pi restarts only after you stop. ` +
      "Reply with one line saying you are waiting for these tools, and make no more tool calls. " +
      "Within a few seconds you will get a message listing the new tools. Continue the task from there."
    );
  }
  if (/\.(read|full)$/.test(item)) {
    const service = item.replace(/\.(read|full)$/, "");
    const how = catalog.services?.[service]?.mcp
      ? `It is an MCP server. Send JSON-RPC with POST to $SPEAKER_URL/${service}: first initialize, then tools/list, then tools/call.`
      : `Call it like this: curl -H "Authorization: Bearer $SPEAKER_TOKEN" $SPEAKER_URL/${service}/<path>`;
    return `${head}. ${how}${help ? ` Notes from the service: ${help}` : ""}`;
  }
  return `${head}.`;
};

export const deniedLine = (item: string) =>
  `Denied: ${item}. Do not ask for it again in this task. Do the work without it. If you can't, write what you could not do, and why, in /output/NOTES.md.`;

export const UNDECIDED =
  "The owner has not decided after 30 minutes. The request stays open. Work on anything that doesn't need it. To check again later, call request_capability with the same items.";

export const reply = (decision: Decision, catalog: CatalogView, help: Record<string, string> = {}) =>
  [
    ...(decision.granted ?? []).map((item) => grantedLine(item, catalog, decision.expiresAt, help[item.replace(/\.(read|full)$/, "")])),
    ...(decision.denied ?? []).map(deniedLine),
  ].join("\n") || "The owner answered but granted and denied nothing. Work without it.";

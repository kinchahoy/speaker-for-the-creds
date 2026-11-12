import { existsSync, readFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const control = { url: process.env.PI_V2_CONTROL!, token: process.env.PI_V2_TOKEN! };
// SPEAKER_TOKEN is a placeholder; the host's speaker door adds the task's agent token.
const speaker = { url: `${process.env.SPEAKER_URL}/_speaker`, token: process.env.SPEAKER_TOKEN! };
const PROMPT = "/etc/pi-v2/prompt.md";
const WAIT_MS = 30 * 60_000;

/** `wait` holds the reply for up to that many seconds (speaker's Speaker-Wait header). */
const call = async (
  to: { url: string; token: string },
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  wait?: number,
) => {
  const response = await fetch(`${to.url}/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${to.token}`,
      ...(wait ? { "speaker-wait": String(wait) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = (await response.json()) as Record<string, any>;
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
};

/** The last assistant text, first 400 characters. The owner sees it in the Tasks view. */
const lastMessage = (
  entries: { type: string; message?: { role?: string; content?: unknown } }[],
) => {
  const content = entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
    .at(-1)?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content as { type: string; text?: string }[])
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n")
        : "";
  return text.slice(0, 400);
};

/**
 * Reports progress to bottle-school and asks speaker for items on the task's behalf. The owner
 * approves each request in speaker; nothing here grants access.
 */
export default function (pi: ExtensionAPI) {
  const report = (busy: boolean, summary?: string) =>
    void call(control, "POST", "guest/status", { busy, summary }).catch(() => undefined);
  // A run spans every model and tool step; Pi settles only when it will not continue on its own.
  pi.on("agent_start", () => report(true));
  pi.on("agent_settled", (_event, ctx) =>
    report(false, lastMessage(ctx.sessionManager.getBranch())),
  );
  pi.on("session_start", (_event, ctx) => {
    report(false);
    // The owner's one-shot prompt starts a fresh session once; a restart resumes without replaying it.
    if (
      existsSync(PROMPT) &&
      !ctx.sessionManager.getBranch().some((entry) => entry.type === "message")
    )
      pi.sendUserMessage(readFileSync(PROMPT, "utf8"));
  });

  pi.registerTool(
    defineTool({
      name: "request_capability",
      label: "Request capability",
      description:
        "Ask the owner for items: a service, site, secret, folder, MCP server, Pi extension, or a named group. Waits up to 30 minutes for the owner's decision and returns what was granted and denied.",
      parameters: Type.Object({
        want: Type.Array(Type.String(), {
          description:
            "Items. <service>.read or <service>.full (homelab APIs and remote MCP servers). site:<host> or site:*.<domain>. secret:<NAME>. folder:<share> or folder:<share>:rw. mcp:<catalog id> (in-VM servers only). ext:<extension catalog id>. group:<name>.",
        }),
        reason: Type.String({ description: "One sentence on what this unblocks" }),
        duration: Type.Union(["30m", "1h", "2h", "1d", "30d"].map((v) => Type.Literal(v))),
      }),
      async execute(_id, params, signal) {
        // Repeating the request joins the pending one, so each hold is at most a minute.
        const deadline = Date.now() + WAIT_MS;
        let result = await call(speaker, "POST", "requests", params, signal, 60);
        while (result.status === "pending" && Date.now() < deadline)
          result = await call(speaker, "POST", "requests", params, signal, 60);
        const { granted = [], denied = [], applying = [], status, id } = result;
        const text =
          status === "pending"
            ? "The owner has not decided yet; continue other work."
            : status === "expired"
              ? `The request for ${params.want.join(", ")} expired undecided; continue other work.`
              : `Granted: ${granted.join(", ") || "nothing"}. Denied: ${denied.join(", ") || "nothing"}.` +
                (applying.length
                  ? ` Granted but not in force yet: ${applying.join(", ")}; the sandbox is applying it (mcp: and ext: items appear after Pi restarts when idle). Retry what was blocked shortly.`
                  : granted.length
                    ? " Use it now: folders are at /input/<share>, websites work directly."
                    : " Continue without it or explain what is blocked.");
        return { content: [{ type: "text", text }], details: { id, status, granted, denied, applying } };
      },
    }),
  );
}

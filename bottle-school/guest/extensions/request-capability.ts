import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const control = { url: process.env.PI_V2_CONTROL!, token: process.env.PI_V2_TOKEN! };
// SPEAKER_TOKEN is a placeholder; Gondolin swaps in the task's subject token only for speaker's host.
const speaker = { url: `${process.env.SPEAKER_URL}/_speaker`, token: process.env.SPEAKER_TOKEN! };
const PROMPT = "/etc/pi-v2/prompt.md";
const POLL_MS = 5_000;
const WAIT_MS = 30 * 60_000;

const call = async (
  to: { url: string; token: string },
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => {
  const response = await fetch(`${to.url}/${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${to.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = (await response.json()) as Record<string, string>;
  if (!response.ok) throw new Error(result.error ?? `${to.url} returned ${response.status}`);
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
 * Reports progress to bottle-school and asks speaker for capabilities on the task's behalf. The owner
 * approves each request in speaker; nothing here grants a capability.
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
        "Ask the owner for a lease: a credential, secret, site, folder, MCP server, or Pi extension, or a named bundle. Waits up to 30 minutes for the owner's decision and returns it.",
      parameters: Type.Object({
        kind: Type.Optional(
          Type.Union(["credential", "secret", "site", "folder", "mcp", "extension"].map((v) => Type.Literal(v))),
        ),
        ref: Type.Optional(
          Type.String({
            description:
              "credential: <provider>.read|write. secret: <NAME>@<host>[,<host>]. site: <host> or *.<domain>. folder: <share> or <share>:rw. mcp: <catalog id>. extension: <extension catalog id>.",
          }),
        ),
        bundle: Type.Optional(Type.String({ description: "A bundle name, in place of kind and ref" })),
        reason: Type.String({ description: "One sentence on what this unblocks" }),
        duration: Type.Union(["15m", "30m", "1h", "1d", "7d", "30d"].map((v) => Type.Literal(v))),
      }),
      async execute(_id, params, signal) {
        const { kind, ref, bundle, reason, duration } = params;
        const capability = kind && ref ? { kind, ref } : undefined;
        const { id } = await call(speaker, "POST", "requests", { capability, bundle, reason, duration }, signal);
        const deadline = Date.now() + WAIT_MS;
        let status = "pending";
        while (status === "pending" && Date.now() < deadline) {
          await sleep(POLL_MS, undefined, { signal });
          ({ status } = await call(speaker, "GET", `requests/${id}`, undefined, signal));
        }
        const what = bundle ? `bundle ${bundle}` : `${kind} ${ref}`;
        const text =
          status === "approved"
            ? `The owner approved ${what}. Retry now.`
            : status === "denied"
              ? `The owner denied ${what}; continue without it or explain what is blocked.`
              : status === "expired"
                ? `The request for ${what} expired undecided; continue other work.`
                : "The owner has not decided yet; continue other work.";
        return { content: [{ type: "text", text }], details: { id, status } };
      },
    }),
  );
}

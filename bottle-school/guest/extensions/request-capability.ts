import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  needsRestart,
  piToolNames,
  reply,
  toolDescription,
  UNDECIDED,
  type CatalogView,
  type Decision,
} from "./reply.ts";

const control = { url: process.env.BOTTLE_SCHOOL_CONTROL!, token: process.env.BOTTLE_SCHOOL_TOKEN! };
// SPEAKER_TOKEN is a placeholder; the host's speaker door adds the task's agent token (and the task's SSH public key,
// which the host provisions, to every request body).
const speaker = { url: `${process.env.SPEAKER_URL}/_speaker`, token: process.env.SPEAKER_TOKEN! };
const PROMPT = "/etc/bottle-school/prompt.md";
const WAIT_MS = 30 * 60_000;
/** Tools the agent was told to wait for; the next session_start wakes it once they are loaded. */
const PENDING_TOOLS = "/work/.speaker/pending-tools.json";
const APPLY_POLL_MS = 2_000;
const APPLY_MAX_MS = 120_000;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

class SpeakerError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, any>,
  ) {
    super(JSON.stringify(body));
  }
}

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
  if (!response.ok) throw new SpeakerError(response.status, result);
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
export default async function (pi: ExtensionAPI) {
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
    // After the restart the agent was told to wait for, say which of those tools are now loaded.
    else if (existsSync(PENDING_TOOLS)) {
      const wanted = JSON.parse(readFileSync(PENDING_TOOLS, "utf8")) as string[];
      rmSync(PENDING_TOOLS);
      const active = new Set(pi.getActiveTools());
      const missing = wanted.filter((name) => !active.has(name));
      pi.sendUserMessage(
        `Pi restarted. These tools are now available: ${wanted.filter((name) => active.has(name)).join(", ") || "none"}.` +
          (missing.length ? ` These did not load: ${missing.join(", ")}.` : "") +
          " Continue the task.",
      );
    }
  });

  // The guidance lives in the tool, so fetch what this agent may ask for now. A failure is shown to the model, not hidden.
  let catalogText: string;
  let catalogFailed = false;
  try {
    catalogText = ((await call(speaker, "GET", "catalog")) as CatalogView).text ?? "";
    if (!catalogText) throw new Error("speaker's catalog has no text");
  } catch (error) {
    catalogFailed = true;
    catalogText = `ERROR: could not read the list of what you can ask for from speaker (${(error as Error).message}). Tell the owner; do not guess item names.`;
  }

  pi.registerTool(
    defineTool({
      name: "request_capability",
      label: "Request capability",
      description: toolDescription(catalogText),
      parameters: Type.Object({
        want: Type.Array(Type.String(), { description: "Items to ask for, written exactly as in this tool's description." }),
        reason: Type.String({ description: "One sentence on what this unblocks." }),
        duration: Type.Union(["30m", "1h", "2h", "1d", "30d"].map((v) => Type.Literal(v))),
      }),
      async execute(_id, params, signal) {
        if (catalogFailed) throw new Error(catalogText);
        const done = (text: string, details: object = {}) => ({ content: [{ type: "text" as const, text }], details });
        // Re-posting the same items joins the pending request, so each hold is at most a minute.
        const deadline = Date.now() + WAIT_MS;
        let decision: Decision;
        try {
          decision = (await call(speaker, "POST", "requests", params, signal, 60)) as Decision;
          while (decision.status === "pending" && Date.now() < deadline)
            decision = (await call(speaker, "POST", "requests", params, signal, 60)) as Decision;
        } catch (error) {
          if (error instanceof SpeakerError && error.status === 400)
            return done(`Not requested: ${error.body.message ?? error.message}`);
          throw error;
        }
        if (decision.status === "pending") return done(UNDECIDED, decision);
        // Speaker lists a granted item under `applying` until the sandbox reports it in force (ext: and mcp: stay
        // there until Pi restarts), so both count as granted here.
        decision = { ...decision, granted: [...(decision.granted ?? []), ...(decision.applying ?? [])] };
        const granted = decision.granted ?? [];
        // Sites, secrets, folders and services reach the VM within seconds; wait so the reply is true when read.
        // ext: and mcp: items only take effect after a Pi restart, which cannot happen during this call.
        const waitFor = granted.filter((item) => !needsRestart(item));
        const fetchCatalog = async () => (await call(speaker, "GET", "catalog", undefined, signal)) as CatalogView;
        const applying = (view: CatalogView) =>
          (view.grants ?? []).filter((grant) => grant.applying && waitFor.includes(grant.item)).map((grant) => grant.item);
        let catalog = await fetchCatalog();
        for (const start = Date.now(); applying(catalog).length && Date.now() - start < APPLY_MAX_MS; ) {
          await sleep(APPLY_POLL_MS);
          catalog = await fetchCatalog();
        }
        const help: Record<string, string> = {};
        for (const item of granted.filter((entry) => /\.(read|full)$/.test(entry))) {
          const service = item.replace(/\.(read|full)$/, "");
          const response = await fetch(`${speaker.url}/help/${service}`, { headers: { authorization: `Bearer ${speaker.token}` }, signal });
          if (response.ok) help[service] = (await response.text()).trim();
        }
        let text = reply(decision, catalog, help);
        const late = applying(catalog);
        if (late.length)
          text += `\nNot in force yet after 2 minutes: ${late.join(", ")}. Retry in a minute; if it still fails, say so in /output/NOTES.md.`;
        const tools = granted.flatMap((item) => piToolNames(item, catalog));
        if (tools.length) {
          mkdirSync("/work/.speaker", { recursive: true });
          const earlier = existsSync(PENDING_TOOLS) ? (JSON.parse(readFileSync(PENDING_TOOLS, "utf8")) as string[]) : [];
          writeFileSync(PENDING_TOOLS, JSON.stringify([...new Set([...earlier, ...tools])]));
        }
        return done(text, decision);
      },
    }),
  );
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  alreadyPendingText,
  changeMessage,
  decisionMessage,
  filedText,
  needsRestart,
  pendingKey,
  reply,
  toolDescription,
  type CatalogView,
  type Decision,
  type GrantChange,
} from "./reply.ts";

const control = { url: process.env.BOTTLE_CONTROL!, token: process.env.BOTTLE_TOKEN! };
// SPEAKER_TOKEN is a placeholder; the host's speaker door adds the agent's token (and the agent's SSH public key,
// which the host provisions, to every request body).
const speaker = { url: `${process.env.SPEAKER_URL}/_speaker`, token: process.env.SPEAKER_TOKEN! };
const PROMPT = "/etc/bottle/prompt.md";
/** Requests filed and not yet delivered, kept so a Pi restart re-arms them. */
const PENDING = "/work/.speaker/pending.json";
const FILE_WAIT_S = 3;
const RETRY_MS = 10_000;
/** Bottle's note of what the last restart changed, and the last change this guest told the agent about (/etc/bottle is read-only). */
const CHANGE = "/etc/bottle/change.json";
const REPORTED = "/work/.speaker/last-change-id";
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
const call = async (to: { url: string; token: string }, method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal, wait?: number) => {
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

/** The last assistant text, first 400 characters. The owner sees it in the Agents view. */
const lastMessage = (entries: { type: string; message?: { role?: string; content?: unknown } }[]) => {
  const content = entries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").at(-1)?.message?.content;
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
 * Reports progress to bottle and asks speaker for items on the agent's behalf. The owner
 * approves each request in speaker; nothing here grants access.
 */
export default async function (pi: ExtensionAPI) {
  const report = (busy: boolean, summary?: string) => void call(control, "POST", "guest/status", { busy, summary }).catch(() => undefined);
  // A run spans every model and tool step; Pi settles only when it will not continue on its own.
  let idle = true;
  pi.on("agent_start", () => {
    idle = false;
    report(true);
  });
  pi.on("agent_settled", (_event, ctx) => {
    idle = true;
    report(false, lastMessage(ctx.sessionManager.getBranch()));
  });
  // Requests the owner has not decided yet, by item set. A background watcher per request delivers the decision.
  type Pending = { id: number | string; params: { want: string[]; reason: string; duration: string } };
  const pending: Record<string, Pending> = existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, "utf8")) : {};
  const watching = new Set<string>();
  const savePending = () => {
    mkdirSync("/work/.speaker", { recursive: true });
    writeFileSync(PENDING, JSON.stringify(pending));
  };
  const tell = (text: string) => {
    if (idle) {
      idle = false;
      pi.sendUserMessage(text);
    } else pi.sendUserMessage(text, { deliverAs: "steer" });
  };
  /** The reply for a decided request, after waiting (up to 2 minutes) for items that apply at once to be in force. */
  const settle = async (decision: Decision, want: string[], signal: AbortSignal | undefined, asMessage: boolean) => {
    // Speaker lists a granted item under `applying` until the sandbox reports it in force (ext: and mcp: stay
    // there until Pi restarts), so both count as granted here.
    decision = { ...decision, granted: [...(decision.granted ?? []), ...(decision.applying ?? [])] };
    const granted = decision.granted ?? [];
    // Sites, secrets, folders and services reach the VM within seconds; wait so the message is true when read.
    const waitFor = granted.filter((item) => !needsRestart(item));
    const fetchCatalog = async () => (await call(speaker, "GET", "catalog", undefined, signal)) as CatalogView;
    const applying = (view: CatalogView) => (view.grants ?? []).filter((grant) => grant.applying && waitFor.includes(grant.item)).map((grant) => grant.item);
    let catalog = await fetchCatalog();
    for (const start = Date.now(); applying(catalog).length && Date.now() - start < APPLY_MAX_MS;) {
      await sleep(APPLY_POLL_MS);
      catalog = await fetchCatalog();
    }
    const help: Record<string, string> = {};
    for (const item of granted.filter((entry) => /\.(read|full)$/.test(entry))) {
      const service = item.replace(/\.(read|full)$/, "");
      const response = await fetch(`${speaker.url}/help/${service}`, { headers: { authorization: `Bearer ${speaker.token}` }, signal });
      if (response.ok) help[service] = (await response.text()).trim();
    }
    let text = asMessage ? decisionMessage(decision, want, catalog, help) : reply(decision, catalog, help);
    const late = applying(catalog);
    if (late.length) text += `\nNot in force yet after 2 minutes: ${late.join(", ")}. Retry in a minute; if it still fails, say so in /output/NOTES.md.`;
    return { text, decision };
  };
  // One long-poll at a time per request, by id: watching never files a new request, even after a decision.
  const watch = async (key: string) => {
    if (watching.has(key)) return;
    watching.add(key);
    const entry = pending[key]!;
    for (;;) {
      try {
        const decision = (await call(speaker, "GET", `requests/${entry.id}`, undefined, undefined, 60)) as Decision;
        if (decision.status === "pending") continue;
        const { text } = await settle(decision, entry.params.want, undefined, true);
        delete pending[key];
        savePending();
        watching.delete(key);
        return tell(text);
      } catch (error) {
        if (error instanceof SpeakerError && (error.status === 400 || error.status === 404)) {
          delete pending[key];
          savePending();
          watching.delete(key);
          return tell(
            error.status === 404
              ? `[speaker] Speaker no longer knows request ${entry.id} for ${entry.params.want.join(", ")} (it restarted, or the request is over a day old). Ask again only if you still need it.`
              : `[speaker] Request for ${entry.params.want.join(", ")} was refused: ${error.body.message ?? error.message}`,
          );
        }
        await sleep(RETRY_MS);
      }
    }
  };
  pi.on("session_start", (_event, ctx) => {
    report(false);
    for (const key of Object.keys(pending)) void watch(key);
    // The owner's one-shot prompt starts a fresh session once; a restart resumes without replaying it.
    if (existsSync(PROMPT) && !ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) tell(readFileSync(PROMPT, "utf8"));
    // After a restart that changed ext:/mcp: grants, tell the agent once what loaded, what did not and what is gone.
    else if (existsSync(CHANGE)) {
      const change = JSON.parse(readFileSync(CHANGE, "utf8")) as GrantChange;
      if (change.id > (existsSync(REPORTED) ? Number(readFileSync(REPORTED, "utf8")) : 0)) {
        mkdirSync("/work/.speaker", { recursive: true });
        writeFileSync(REPORTED, String(change.id));
        tell(changeMessage(change, pi.getActiveTools()));
      }
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
        const key = pendingKey(params.want);
        if (pending[key]) return done(alreadyPendingText(pending[key].id), pending[key]);
        let decision: Decision & { id?: number | string };
        try {
          decision = (await call(speaker, "POST", "requests", params, signal, FILE_WAIT_S)) as typeof decision;
        } catch (error) {
          if (error instanceof SpeakerError && error.status === 400) return done(`Not requested: ${error.body.message ?? error.message}`);
          throw error;
        }
        if (decision.status === "pending") {
          pending[key] = { id: decision.id ?? "(no id)", params };
          savePending();
          void watch(key);
          return done(filedText(pending[key].id), decision);
        }
        const settled = await settle(decision, params.want, signal, false);
        return done(settled.text, settled.decision);
      },
    }),
  );
}

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { kindOf, type ItemKind } from "../../speaker/items.ts";
import { type Table, transition } from "../../speaker/lifecycle.ts";
import { localModelReady, type Config } from "./config.ts";
import { boot, note, type Boot, type Guest, type Live } from "./sandbox.ts";
import { givenAtLaunch, launchFolders, launchRequest, refOf, secretHosts, siteRef, StatusError, unexpired } from "./grants.ts";
import { availableModels, grantChange, pi, writeGrantChange, writeGuestConfig, type Catalog } from "./pi.ts";
import { speakerCa, speakerClient, speakerProxy, watchGrants, type Grant, type SecretInfo, type Snapshot } from "./speaker.ts";

/**
 * An agent's lifecycle. `starting` until Pi first runs, or `awaiting-grant` while a one-shot agent waits for its hosted
 * model's speaker service grant (Pi has not started); then `idle` and `busy` as the guest reports; `reconfiguring` while Pi restarts with
 * new MCP servers or extensions; `closing` while it is archived. `start-failed` means Pi never started; `pi-down` means
 * a restart failed after Pi had run, so it has a transcript to export. A failed close ends in `failed-archive` with the
 * work tree kept.
 */
export type AgentState =
  | "starting"
  | "awaiting-grant"
  | "idle"
  | "busy"
  | "reconfiguring"
  | "pi-down"
  | "start-failed"
  | "closing"
  | "archived"
  | "failed-archive";
type AgentEvent = "ready" | "wait" | "start" | "work" | "rest" | "reconfigure" | "fail" | "close" | "archive" | "archiveFailed";
const agentTable: Table<AgentState, AgentEvent> = {
  starting: { ready: "idle", wait: "awaiting-grant", fail: "start-failed", close: "closing" },
  "awaiting-grant": { start: "starting", close: "closing" },
  idle: { work: "busy", rest: "idle", reconfigure: "reconfiguring", close: "closing" },
  busy: { work: "busy", rest: "idle", close: "closing" },
  reconfiguring: { ready: "idle", fail: "pi-down", close: "closing" },
  "pi-down": { close: "closing" },
  "start-failed": { close: "closing" },
  closing: { archive: "archived", archiveFailed: "failed-archive" },
  archived: {},
  "failed-archive": {},
};
const piExited = "Pi exited; attach to restart it on the same session";
export const closed = (agent: Pick<Agent, "state">) => ["closing", "archived", "failed-archive"].includes(agent.state);

const ArchivedAgent = z.object({ id: z.string(), name: z.string(), state: z.string(), model: z.string(), closedAt: z.string() });
/** The newest finished agents, read from their archive folders (<time>--<name>--<id>): each one's final agent.json plus its folder. */
export const finishedAgents = (outputRoot: string, count = 5) =>
  readdirSync(outputRoot)
    .sort()
    .reverse()
    .flatMap((folder) => {
      const outputDir = join(outputRoot, folder);
      try {
        const { id, name, state, model, closedAt } = ArchivedAgent.parse(JSON.parse(readFileSync(join(outputDir, "_control", "agent.json"), "utf8")));
        return [{ id, name, state, model, closedAt, outputDir }];
      } catch {
        return []; // a live agent's folder has no agent.json yet
      }
    })
    .slice(0, count);
/** Pi never ran in these states, so there is no session to quit or export. */
const neverRan = (agent: Pick<Agent, "state">) => agent.state === "start-failed" || agent.state === "awaiting-grant";

export type Agent = {
  id: string;
  name: string;
  slug: string;
  state: AgentState;
  templateId: string;
  /** The owner answers questions at the terminal; see attendedFor. */
  attended: boolean;
  model: string;
  /** Bottle's per-agent token for the guest's control calls (the guest sees it as BOTTLE_TOKEN). */
  guestToken: string;
  speakerAgentId: string;
  /** The agent's token at speaker. It stays on the host: the guest only has a placeholder for it (SPEAKER_TOKEN). */
  agentToken: string;
  startedAt: string;
  deadline: string;
  workDir: string;
  outputDir: string;
  guestConfigDir: string;
  prompt?: string;
  lastMessage?: string;
  /** A short task title: what Pi named its session. */
  title?: string;
  /** The deadline and the DONE watch; the close path clears them. */
  timers: Set<NodeJS.Timeout>;
  /** Work in flight, shared by concurrent callers: the archive and the next Pi restart. */
  jobs: { close?: Promise<void>; restart?: Promise<void> };
  /** The latest speaker snapshot for this agent's speaker record. */
  grants: Grant[];
  /** The MCP servers Pi started with. */
  mcpRunning: string[];
  /** The catalog extensions Pi started with. */
  extRunning: string[];
  /** Extensions the template gave at launch, outside speaker (see givenAtLaunch); Pi always loads them. */
  launchExt: string[];
  /** The id of the latest grant change written for the guest (see grantChange). */
  changeId: number;
  live: Live;
  guest: Guest;
};

type Entry = { path: string; bytes?: number; sha256?: string; type: "file" | "directory" | "symlink" | "other" };
/** Agent-created links never make the trusted archiver follow paths outside artifacts. */
const walk = (root: string, prefix = ""): Entry[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry): Entry[] => {
    const path = `${root}/${entry.name}`;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return [{ path: relative, type: "directory" }, ...walk(path, relative)];
    if (entry.isFile())
      return [{ path: relative, bytes: lstatSync(path).size, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), type: "file" }];
    return [{ path: relative, type: entry.isSymbolicLink() ? "symlink" : "other" }];
  });

/**
 * Writes a closed agent's trusted records into `<outputDir>/_control`: the Pi session and transcript, agent.json,
 * policy-events.jsonl and the artifacts manifest. (The model door has already appended model-calls.jsonl there.)
 */
function writeArchive(agent: Agent, status: "archived" | "failed-archive", error?: string) {
  const control = `${agent.outputDir}/_control`;
  const closedAt = new Date().toISOString();
  const session = `${agent.workDir}/.pi-session/agent.jsonl`;
  const transcript = `${agent.workDir}/transcript.html`;
  if (existsSync(session)) copyFileSync(session, `${control}/pi-session.jsonl`);
  else note(agent.live, "Pi session file was unavailable during archival");
  if (existsSync(transcript)) copyFileSync(transcript, `${control}/transcript.html`);
  else note(agent.live, "Pi transcript export was unavailable during archival");
  const lines = (records: object[]) => records.map((record) => JSON.stringify(record)).join("\n");
  const { id, name, slug, templateId, attended, speakerAgentId, model, startedAt, deadline } = agent;
  const record = { id, name, slug, state: status, templateId, attended, speakerAgentId, model, startedAt, deadline, closedAt, ...(error ? { error } : {}) };
  writeFileSync(`${control}/agent.json`, JSON.stringify(record, null, 2));
  writeFileSync(`${control}/policy-events.jsonl`, lines(agent.live.events));
  const manifest = { closed: status === "archived", files: walk(`${agent.outputDir}/artifacts`), ...(error ? { error } : {}) };
  writeFileSync(`${control}/manifest.json`, JSON.stringify(manifest, null, 2));
}

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "agent";
const stamp = (date: Date) => date.toISOString().slice(0, 16).replace("T", "_").replace(":", "");
const differs = (wanted: string[], running: string[]) => wanted.length !== running.length || wanted.some((id) => !running.includes(id));

/**
 * The grants in effect for an agent, as speaker should hear them: site, secret and folder grants apply the moment they
 * are installed; an MCP server or extension only once Pi has restarted with it.
 */
export const inForce = (grants: Grant[], running: { mcp: string[]; ext: string[] }) =>
  unexpired(grants)
    .filter((grant) => {
      const kind = kindOf(grant.item);
      return (kind !== "mcp" || running.mcp.includes(refOf(grant.item))) && (kind !== "ext" || running.ext.includes(refOf(grant.item)));
    })
    .map((grant) => grant.id);

/** Speaker failing is not the owner's mistake: it answers 502. */
const upstream = <T>(call: Promise<T>) =>
  call.catch((error: Error) => {
    throw new StatusError(502, error.message);
  });

/** A model id or alias (default: the first configured model) as its full id; unknown names fail with the choices. */
export const resolveModel = (config: Config, wanted?: string) => {
  const models = availableModels(config);
  if (wanted === undefined) return models[0]!.id;
  const found = models.find((entry) => entry.id === wanted || entry.alias === wanted);
  if (!found)
    throw new StatusError(
      400,
      `model ${wanted} is not configured; use one of: ${models.map((entry) => (entry.alias ? `${entry.alias} (${entry.id})` : entry.id)).join(", ")}`,
    );
  return found.id;
};

export class Agents {
  readonly byId = new Map<string, Agent>();
  readonly byGuestToken = new Map<string, Agent>();
  readonly #report: ReturnType<typeof watchGrants>;
  readonly #boot: Boot;
  #requests: Snapshot["requests"] = [];
  /** The secrets the owner set up in speaker, as the last snapshot listed them (names and hosts, never values). */
  secrets: SecretInfo[] = [];
  readonly speaker: ReturnType<typeof speakerClient>;
  readonly config: Config;
  catalog: Catalog;

  /** `vm` starts an agent's VM; tests pass a stand-in. */
  constructor(config: Config, catalog: Catalog, hostToken: string, vm: Boot = boot) {
    this.config = config;
    this.catalog = catalog;
    this.#boot = vm;
    this.speaker = speakerClient(config, hostToken);
    this.#report = watchGrants(config, hostToken, (snapshot) => this.#onSnapshot(snapshot), catalog, {
      // Through the normal shutdown, which archives the agents.
      onGone: (why) => (console.error(`stopping bottle: ${why}`), (process.exitCode = 1), process.kill(process.pid, "SIGTERM")),
    });
  }

  list = () => [...this.byId.values()];
  /** Swaps in a re-read catalog and tells speaker. Running agents keep the extensions they loaded; grants are applied against the new catalog from the next snapshot. */
  reloadCatalog = (catalog: Catalog) => {
    this.catalog = catalog;
    this.#report.catalog(catalog);
  };
  /** Closes the connection to speaker (the agents stay as they are). */
  stop = () => this.#report.stop();
  /** One line on the link to speaker. */
  speakerStatus = () => this.#report.status();
  get = (id: string) => {
    const agent = this.byId.get(id);
    if (!agent) throw new StatusError(404, `no active agent ${id}`);
    return agent;
  };
  #move = (agent: Agent, event: AgentEvent) => {
    agent.state = transition("agent", agentTable, agent.state, event);
  };
  /** Sends speaker each agent's title; it only goes out when a title changed. */
  reportTitles = () => this.#report.titles(Object.fromEntries(this.list().flatMap((agent) => (agent.title ? [[agent.speakerAgentId, agent.title]] : []))));
  /** The guest reports Pi working or resting; only an idle or busy agent follows it. */
  report = (agent: Agent, busy: boolean) => {
    if (agent.state === "idle" || agent.state === "busy") this.#move(agent, busy ? "work" : "rest");
  };

  async create(input: {
    name?: string;
    template: string;
    model?: string;
    prompt?: string;
    attended?: boolean;
    hours?: number;
    folders?: string[];
  }): Promise<Agent> {
    // Closed and failed-archive agents stay listed for the owner but no longer hold a slot.
    if (this.list().filter((agent) => !closed(agent)).length >= this.config.maxAgents)
      throw new StatusError(409, `already running ${this.config.maxAgents} agents`);
    const template = this.config.templates.find(({ id }) => id === input.template);
    if (!template) throw new StatusError(400, `no template ${input.template}`);
    const attended = input.attended ?? true;
    const name = input.name ?? template.id;
    const model = resolveModel(this.config, input.model ?? template.model);
    if (model.startsWith("local/") && !(await localModelReady(this.config)))
      throw new StatusError(400, `the local model server ${this.config.localModel.upstream} is not answering; start it or pick another model with -m`);
    const folders = launchFolders([...template.folders, ...(input.folders ?? [])]);
    const launchExt = givenAtLaunch(template, this.catalog.extensions);
    const hours = input.hours ?? template.limits.maxRuntimeHours;
    if (hours > template.limits.maxRuntimeHours)
      throw new StatusError(400, `template ${template.id} limits an agent to ${template.limits.maxRuntimeHours} hours`);
    for (const [root, GiB, label] of [
      [this.config.stateRoot, template.limits.workGiB, "state"],
      [this.config.outputRoot, 1, "output"],
    ] as const) {
      const disk = await statfs(root);
      if (disk.bavail * disk.bsize < GiB * 1024 ** 3) throw new Error(`the ${label} filesystem has less than ${GiB} GiB free`);
    }

    const id = randomBytes(4).toString("hex");
    const slug = slugify(name);
    const workDir = `${this.config.stateRoot}/agents/${id}/work`;
    const guestConfigDir = `${this.config.stateRoot}/agents/${id}/guest-config`;
    const outputDir = `${this.config.outputRoot}/${stamp(new Date())}--${slug}--${id}`;
    for (const dir of [`${workDir}/.pi-session`, `${outputDir}/artifacts`, `${outputDir}/_control`]) mkdirSync(dir, { recursive: true });
    const events = [
      { at: new Date().toISOString(), text: `agent launched ${attended ? "attended" : "unattended"} from template ${template.id}` },
      ...folders.map((folder) => ({
        at: new Date().toISOString(),
        text: `mounted ${folder.path} at ${folder.mount} ${folder.writable ? "read-write" : "read-only"}`,
      })),
      ...(launchExt.length
        ? [{ at: new Date().toISOString(), text: `given at launch by template ${template.id}: ${launchExt.map((id) => `ext:${id}`).join(", ")}` }]
        : []),
    ];
    const live: Live = {
      hosts: [],
      secretHosts: [],
      shares: new Map(),
      events,
      modelRequests: 0,
      maxModelRequests: template.limits.maxModelRequests,
      modelCapNoted: false,
    };
    const guestToken = randomBytes(24).toString("hex");
    // The agent's label is the agent as the owner would say it: the launch name, else the template's label.
    const speakerAgent = await upstream(
      this.speaker.createAgent(
        input.name ?? template.label,
        `${model} · Pi on ${hostname()}`,
        launchExt.map((id) => `ext:${id}`),
      ),
    );
    let guest: Guest;
    try {
      // Speaker's proxy certificate, fetched once for the guest's trust store and bottle's own tunnel to the proxy.
      const ca = await upstream(speakerCa(this.config));
      writeGuestConfig(
        guestConfigDir,
        this.config,
        this.catalog,
        { name, model, prompt: input.prompt, attended, folders: folders.map((folder) => folder.mount), launchExt },
        [],
        [],
        launchExt,
      );
      guest = await this.#boot(
        this.config,
        live,
        template.limits,
        { work: workDir, artifacts: `${outputDir}/artifacts`, guestConfig: guestConfigDir, modelCalls: `${outputDir}/_control/model-calls.jsonl`, folders },
        {
          BOTTLE_TOKEN: guestToken,
          BOTTLE_CONTROL: "http://control.internal",
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          PI_SKIP_VERSION_CHECK: "1",
          PI_PROGRAM_STATUS: "1",
          // pi-subagents, always on in the image, kept small: 2 children per delegation and no nesting. pi.ts holds their model to the agent's own.
          PI_SUBAGENT_MAX_SPAWNS_PER_RUN: "2",
          PI_SUBAGENT_MAX_DEPTH: "1",
        },
        { url: this.config.speaker.url, agentToken: speakerAgent.agentToken, ca },
        speakerProxy(this.config, speakerAgent.agentToken, ca),
      );
    } catch (error) {
      rmSync(`${this.config.stateRoot}/agents/${id}`, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
      await this.speaker.deleteAgent(speakerAgent.id).catch(() => undefined); // the boot error is the one to report
      throw error;
    }

    const agent: Agent = {
      id,
      name,
      slug,
      state: "starting",
      templateId: template.id,
      attended,
      prompt: input.prompt,
      model,
      guestToken,
      speakerAgentId: speakerAgent.id,
      agentToken: speakerAgent.agentToken,
      startedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + hours * 3_600_000).toISOString(),
      workDir,
      outputDir,
      guestConfigDir,
      timers: new Set(),
      jobs: {},
      grants: [],
      mcpRunning: [],
      extRunning: launchExt,
      launchExt,
      changeId: 0,
      live,
      guest,
    };
    this.byId.set(id, agent);
    this.byGuestToken.set(guestToken, agent);
    // A launch prompt is sent once, to a fresh session: if the hosted model's service were not granted yet, that first
    // turn would fail for good. Pi then starts when the grant arrives (see #startWhenGranted).
    const awaitGrant = Boolean(input.prompt) && this.#modelService(model).length > 0;
    try {
      // The template's want list is the agent's first request. A hosted model's speaker service is asked for here too.
      const first = launchRequest(template, agent.speakerAgentId, this.#modelService(model), launchExt);
      if (first) await upstream(this.speaker.request({ ...first, ...(guest.sshKey ? { sshKey: guest.sshKey } : {}) }));
      if (!awaitGrant) await pi.start(guest);
    } catch (error) {
      note(live, `Pi start failed: ${(error as Error).message}`);
      this.#move(agent, "fail");
      await this.close(agent).catch(() => undefined); // the launch error is the one the owner needs
      throw error;
    }
    this.#move(agent, awaitGrant ? "wait" : "ready");
    // The grant may have come in a snapshot while the agent was still starting.
    this.#startWhenGranted(agent);
    if (input.prompt) {
      note(live, `owner launch prompt queued; archival at ${agent.deadline}`);
      // A one-shot agent ends when the agent writes DONE to /output; the archive records it.
      agent.timers.add(
        setInterval(() => {
          if (!this.done(agent)) return;
          note(live, "agent wrote DONE");
          this.close(agent).catch(() => undefined); // close records a failed archive in the agent state
        }, 15_000).unref(),
      );
    }
    this.#apply(agent);
    // Pi can exit on its own (a crash, /quit) and then reports nothing, so an agent would stay busy forever: check, and say so.
    agent.timers.add(
      setInterval(async () => {
        if ((agent.state !== "idle" && agent.state !== "busy") || agent.jobs.restart || agent.lastMessage === piExited) return;
        if (await pi.running(guest).catch(() => true)) return;
        note(live, "Pi exited");
        agent.lastMessage = piExited;
        this.#move(agent, "rest");
      }, 30_000).unref(),
    );
    agent.timers.add(
      setTimeout(() => {
        note(live, "deadline reached");
        this.close(agent).catch(() => undefined);
      }, hours * 3_600_000).unref(),
    );
    return agent;
  }

  /** A hosted model's calls need its provider's speaker service in full (a chat completion is a POST); a local model needs none. */
  #modelService = (model: string) =>
    this.config.hostedProviders.filter((provider) => provider.id === model.split("/")[0]).map((provider) => `${provider.service}.full`);

  /** Whether bottle can enforce a grant: speaker's items are checked against the shared grammar, then against what this host offers. */
  #supported = (grant: Grant) => {
    const ref = refOf(grant.item);
    switch (kindOf(grant.item)) {
      case "service":
      case "folder":
        return true;
      case "secret":
        // A released secret (no hosts) needs nothing from bottle: the agent reads it from speaker.
        return grant.hosts?.length === 0 || secretHosts.safeParse(grant.hosts).success;
      case "site":
        return siteRef.safeParse(ref).success;
      case "mcp":
        return Object.hasOwn(this.catalog.mcps, ref);
      case "ext":
        return Object.hasOwn(this.catalog.extensions, ref);
      default:
        return false;
    }
  };

  /** Replaces every agent's grants with a speaker snapshot, then reports what is in effect. */
  #onSnapshot({ grants, requests, secrets }: Snapshot) {
    this.#requests = requests;
    if (secrets) this.secrets = secrets;
    for (const agent of this.byId.values()) {
      const mine = grants.filter((grant) => {
        if (grant.agentId !== agent.speakerAgentId) return false;
        const supported = this.#supported(grant);
        if (!supported) note(agent.live, `skipped unsupported grant ${grant.id}: ${grant.item}`);
        return supported;
      });
      const key = (set: Grant[]) => JSON.stringify(set.map((grant) => grant.id).sort());
      if (key(mine) !== key(agent.grants)) {
        appendFileSync(`${agent.outputDir}/_control/grants.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), grants: mine })}\n`);
        note(agent.live, `grants now: ${mine.map((grant) => grant.item).join(", ") || "none"}`);
      }
      agent.grants = mine;
      this.#apply(agent);
      this.#startWhenGranted(agent);
    }
    this.#reportApplied();
  }

  /** Reports to speaker which grants are in force (see inForce). */
  #reportApplied() {
    this.#report(this.list().flatMap((agent) => inForce(agent.grants, { mcp: agent.mcpRunning, ext: agent.extRunning })));
  }

  /** An agent awaiting its hosted model's service starts Pi once speaker shows the grant. */
  #startWhenGranted(agent: Agent) {
    const granted = this.#granted(agent, "service").map((grant) => grant.item);
    if (agent.state === "awaiting-grant" && this.#modelService(agent.model).every((item) => granted.includes(item))) void this.#restartAtIdle(agent);
  }

  #granted = (agent: Agent, kind: ItemKind) => unexpired(agent.grants).filter((grant) => kindOf(grant.item) === kind);
  #wanted = (agent: Agent, kind: "mcp" | "ext") => {
    const known = kind === "mcp" ? this.catalog.mcps : this.catalog.extensions;
    const granted = this.#granted(agent, kind).map((grant) => refOf(grant.item));
    return [...new Set([...(kind === "ext" ? agent.launchExt : []), ...granted])].filter((id) => known[id]);
  };

  /** Moves the live agent view to its grants. Hosts and shares are replaced as a whole, so no grant outlives its snapshot. */
  #apply(agent: Agent) {
    agent.live.secretHosts = this.#granted(agent, "secret")
      .filter(({ hosts }) => hosts?.length)
      .map(({ item, hosts, expiresAt }) => ({
        name: refOf(item),
        hosts: secretHosts.parse(hosts),
        expiresAt,
      }));
    // Secret and extension grants also open egress to the hosts they declare.
    agent.live.hosts = [
      ...this.#granted(agent, "site").map(({ item, expiresAt }) => ({ host: refOf(item), expiresAt })),
      ...this.#granted(agent, "ext").flatMap(({ item, expiresAt }) => (this.catalog.extensions[refOf(item)]?.sites ?? []).map((host) => ({ host, expiresAt }))),
      ...agent.live.secretHosts.flatMap(({ hosts, expiresAt }) => hosts.map((host) => ({ host, expiresAt }))),
    ];
    agent.live.shares.clear();
    for (const { item, expiresAt } of this.#granted(agent, "folder")) {
      const [share, mode] = refOf(item).split(":") as [string, string | undefined];
      if (!agent.live.shares.has(share) || mode === "rw") agent.live.shares.set(share, { expiresAt, writable: mode === "rw" });
    }
    // Pi loads MCP servers and extensions only at start, so a changed set restarts it at the next idle boundary.
    const changed = differs(this.#wanted(agent, "mcp"), agent.mcpRunning) || differs(this.#wanted(agent, "ext"), agent.extRunning);
    if (changed && (agent.state === "idle" || agent.state === "busy")) void this.#restartAtIdle(agent);
  }

  /** Pi requests access from speaker directly; snapshots carry each request's status. */
  pendingRequests = (agent: Agent) =>
    this.#requests
      .filter((request) => request.agentId === agent.speakerAgentId && request.status === "pending")
      .map(({ id, what, reason }) => ({ id, what, reason }));

  done = (agent: Agent) => existsSync(`${agent.outputDir}/artifacts/DONE`);

  /** Restarts Pi at the next idle boundary with the current configuration; an agent still awaiting its model's grant starts Pi for the first time. */
  #restartAtIdle(agent: Agent) {
    const run =
      agent.jobs.restart ??
      (async () => {
        while (agent.state === "busy" || agent.state === "starting") await delay(250);
        const first = agent.state === "awaiting-grant";
        if (agent.state !== "idle" && !first) return;
        this.#move(agent, first ? "start" : "reconfigure");
        // A close may begin while Pi restarts; the restart then leaves the state alone.
        const working = first ? "starting" : "reconfiguring";
        const mcpIds = this.#wanted(agent, "mcp");
        const extIds = this.#wanted(agent, "ext");
        try {
          writeGuestConfig(agent.guestConfigDir, this.config, this.catalog, agent, agent.grants, mcpIds, extIds);
          const items = (mcp: string[], ext: string[]) => [...mcp.map((id) => `mcp:${id}`), ...ext.map((id) => `ext:${id}`)];
          const change = grantChange(this.catalog, agent.changeId + 1, items(agent.mcpRunning, agent.extRunning), items(mcpIds, extIds));
          if (change.added.length || change.removed.length) {
            writeGrantChange(agent.guestConfigDir, change);
            agent.changeId = change.id;
          }
          await (first ? pi.start(agent.guest) : pi.restart(agent.guest));
        } catch (error) {
          note(agent.live, `Pi ${first ? "start" : "restart"} failed: ${(error as Error).message}`);
          if (agent.state === working) this.#move(agent, "fail");
          return;
        }
        agent.mcpRunning = mcpIds;
        agent.extRunning = extIds;
        note(agent.live, `Pi ${first ? "started" : "resumed"} with MCP servers: ${mcpIds.join(", ") || "none"}; extensions: ${extIds.join(", ") || "none"}`);
        if (agent.state === working) this.#move(agent, "ready");
      })().finally(() => {
        agent.jobs.restart = undefined;
      });
    agent.jobs.restart = run;
    // Grants may have changed during the restart; apply them again and report the new in-effect set.
    return run.then(() => {
      this.#apply(agent);
      this.#reportApplied();
    });
  }

  /** Starts Pi again on the agent's session when the owner had quit it; true when it had to. */
  async resume(agent: Agent) {
    if (!["idle", "busy"].includes(agent.state)) throw new StatusError(409, `agent ${agent.id} is ${agent.state}`);
    if (await pi.running(agent.guest)) return false;
    await pi.restart(agent.guest);
    if (agent.lastMessage === piExited) agent.lastMessage = undefined;
    note(agent.live, "Pi restarted after the owner quit it");
    return true;
  }

  /** Close writes trusted records before it removes only the disposable agent work tree. */
  close(agent: Agent): Promise<void> {
    agent.jobs.close ??= this.#close(agent).finally(() => {
      agent.jobs.close = undefined;
    });
    return agent.jobs.close;
  }

  async #close(agent: Agent) {
    if (!this.byId.has(agent.id) || closed(agent)) return;
    // An agent whose Pi never started has no guest session to stop or export; an agent whose Pi went down has a transcript.
    const started = !neverRan(agent);
    this.#move(agent, "close");
    for (const timer of agent.timers) clearTimeout(timer);
    note(agent.live, "owner began archival");
    try {
      if (started) {
        await pi.quit(agent.guest);
        for (let tries = 0; tries < 20 && (await pi.running(agent.guest)); tries += 1) await delay(250);
        if (await pi.running(agent.guest)) {
          note(agent.live, "Pi did not exit after the grace period; killed");
          await pi.kill(agent.guest);
        }
        await pi.export(agent.guest);
      }
      writeArchive(agent, "archived");
      await agent.guest.close();
      await this.speaker.deleteAgent(agent.speakerAgentId);
      rmSync(`${this.config.stateRoot}/agents/${agent.id}`, { recursive: true, force: true });
      this.byId.delete(agent.id);
      this.byGuestToken.delete(agent.guestToken);
      this.#move(agent, "archive");
    } catch (error) {
      const message = (error as Error).message;
      note(agent.live, `archive failed: ${message}`);
      this.#move(agent, "archiveFailed");
      // The VM and its speaker identity must not outlive the agent; the work tree stays for the owner.
      try {
        writeArchive(agent, "failed-archive", message);
      } finally {
        await Promise.allSettled([agent.guest.close(), this.speaker.deleteAgent(agent.speakerAgentId)]);
      }
      throw error;
    }
  }
}

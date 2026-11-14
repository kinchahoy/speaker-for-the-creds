import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { hostname } from "node:os";
import { kindOf, type ItemKind } from "../../speaker/items.ts";
import { type Table, transition } from "../../speaker/lifecycle.ts";
import type { Config } from "./config.ts";
import { boot, note, type Boot, type Guest, type Live } from "./sandbox.ts";
import { attendedFor, launchRequest, refOf, secretHosts, siteRef, StatusError, unexpired, type Template } from "./grants.ts";
import { availableModels, pi, writeGuestConfig, type Catalog } from "./pi.ts";
import { speakerCa, speakerClient, speakerProxy, watchGrants, type Grant, type SecretInfo, type Snapshot } from "./speaker.ts";
import { writeArchive } from "./trace.ts";

/**
 * A task's lifecycle. `starting` until Pi first runs, or `awaiting-key` while a one-shot task waits for its hosted
 * model's key (Pi has not started); then `idle` and `busy` as the guest reports; `reconfiguring` while Pi restarts with
 * new MCP servers or extensions; `closing` while it is archived. `start-failed` means Pi never started; `pi-down` means
 * a restart failed after Pi had run, so it has a transcript to export. A failed close ends in `failed-archive` with the
 * work tree kept.
 */
export type TaskState =
  | "starting"
  | "awaiting-key"
  | "idle"
  | "busy"
  | "reconfiguring"
  | "pi-down"
  | "start-failed"
  | "closing"
  | "archived"
  | "failed-archive";
type TaskEvent = "ready" | "wait" | "start" | "work" | "rest" | "reconfigure" | "fail" | "close" | "archive" | "archiveFailed";
const taskTable: Table<TaskState, TaskEvent> = {
  starting: { ready: "idle", wait: "awaiting-key", fail: "start-failed", close: "closing" },
  "awaiting-key": { start: "starting", close: "closing" },
  idle: { work: "busy", rest: "idle", reconfigure: "reconfiguring", close: "closing" },
  busy: { work: "busy", rest: "idle", close: "closing" },
  reconfiguring: { ready: "idle", fail: "pi-down", close: "closing" },
  "pi-down": { close: "closing" },
  "start-failed": { close: "closing" },
  closing: { archive: "archived", archiveFailed: "failed-archive" },
  archived: {},
  "failed-archive": {},
};
export const closed = (task: Pick<Task, "state">) => ["closing", "archived", "failed-archive"].includes(task.state);
/** Pi never ran in these states, so there is no session to quit or export. */
const neverRan = (task: Pick<Task, "state">) => task.state === "start-failed" || task.state === "awaiting-key";

export type Task = {
  id: string;
  name: string;
  slug: string;
  state: TaskState;
  templateId: string;
  /** The owner answers questions at the terminal; see attendedFor. */
  attended: boolean;
  model: string;
  /** Bottle's per-task token for the guest's control calls (the guest sees it as BOTTLE_TOKEN). */
  guestToken: string;
  agentId: string;
  /** The task's agent token at speaker. It stays on the host: the guest only has a placeholder for it (SPEAKER_TOKEN). */
  agentToken: string;
  startedAt: string;
  deadline: string;
  workDir: string;
  outputDir: string;
  guestConfigDir: string;
  prompt?: string;
  lastMessage?: string;
  lastMessageAt?: string;
  /** The deadline and the DONE watch; the close path clears them. */
  timers: Set<NodeJS.Timeout>;
  /** Work in flight, shared by concurrent callers: the archive and the next Pi restart. */
  jobs: { close?: Promise<void>; restart?: Promise<void> };
  /** The latest speaker snapshot for this task's agent. */
  grants: Grant[];
  /** The MCP servers Pi started with. */
  mcpRunning: string[];
  /** The catalog extensions Pi started with. */
  extRunning: string[];
  events: Live["events"];
  /** Placeholders speaker issued for this task's hosted-model key (provider secret name to placeholder). */
  keys: Map<string, string>;
  live: Live;
  guest: Guest;
};

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "task";
const stamp = (date: Date) => date.toISOString().slice(0, 16).replace("T", "_").replace(":", "");
const differs = (wanted: string[], running: string[]) => wanted.length !== running.length || wanted.some((id) => !running.includes(id));

/**
 * The grants in effect for a task, as speaker should hear them: site, secret and folder grants apply the moment they
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

export class Tasks {
  readonly byId = new Map<string, Task>();
  readonly byGuestToken = new Map<string, Task>();
  readonly #report: ReturnType<typeof watchGrants>;
  readonly #boot: Boot;
  #requests: Snapshot["requests"] = [];
  /** The secrets the owner set up in speaker, as the last snapshot listed them (names and hosts, never values). */
  secrets: SecretInfo[] = [];
  readonly speaker: ReturnType<typeof speakerClient>;
  readonly config: Config;
  readonly templates: Map<string, Template>;
  readonly catalog: Catalog;

  /** `vm` starts a task's VM; tests pass a stand-in. */
  constructor(config: Config, templates: Map<string, Template>, catalog: Catalog, hostToken: string, vm: Boot = boot) {
    this.config = config;
    this.templates = templates;
    this.catalog = catalog;
    this.#boot = vm;
    this.speaker = speakerClient(config, hostToken);
    this.#report = watchGrants(
      config,
      hostToken,
      (snapshot) => this.#onSnapshot(snapshot),
      // Without speaker no grant can apply: stop through the normal shutdown (archives tasks) and exit nonzero.
      (message) => {
        console.error(`stopping bottle: ${message}`);
        process.exitCode = 1;
        process.kill(process.pid, "SIGTERM");
      },
      undefined,
      catalog,
    );
  }

  list = () => [...this.byId.values()];
  /** Closes the connection to speaker (the tasks stay as they are). */
  stop = () => this.#report.stop();
  get = (id: string) => {
    const task = this.byId.get(id);
    if (!task) throw new StatusError(404, `no active task ${id}`);
    return task;
  };
  #move = (task: Task, event: TaskEvent) => {
    task.state = transition("task", taskTable, task.state, event);
  };
  /** The guest reports Pi working or resting; only an idle or busy task follows it. */
  report = (task: Task, busy: boolean) => {
    if (task.state === "idle" || task.state === "busy") this.#move(task, busy ? "work" : "rest");
  };

  async create(input: { name?: string; template: string; model?: string; prompt?: string; attended?: boolean; hours?: number }): Promise<Task> {
    // Closed and failed-archive tasks stay listed for the owner but no longer hold a slot.
    if (this.list().filter((task) => !closed(task)).length >= this.config.maxTasks) throw new StatusError(409, `already running ${this.config.maxTasks} tasks`);
    const template = this.templates.get(input.template);
    if (!template) throw new StatusError(400, `no template ${input.template}`);
    const attended = attendedFor(template, input);
    const name = input.name ?? template.id;
    const model = input.model ?? `local/${this.config.localModel.models[0]!.id}`;
    const models = availableModels(this.config).map((entry) => entry.id);
    if (!models.includes(model)) throw new StatusError(400, `model ${model} is not configured; use one of: ${models.join(", ")}`);
    const hours = input.hours ?? template.limits.maxRuntimeHours;
    if (hours > template.limits.maxRuntimeHours)
      throw new StatusError(400, `template ${template.id} limits a task to ${template.limits.maxRuntimeHours} hours`);
    for (const [root, GiB, label] of [
      [this.config.stateRoot, template.limits.workGiB, "state"],
      [this.config.outputRoot, 1, "output"],
    ] as const) {
      const disk = await statfs(root);
      if (disk.bavail * disk.bsize < GiB * 1024 ** 3) throw new Error(`the ${label} filesystem has less than ${GiB} GiB free`);
    }

    const id = randomBytes(4).toString("hex");
    const slug = slugify(name);
    const workDir = `${this.config.stateRoot}/tasks/${id}/work`;
    const guestConfigDir = `${this.config.stateRoot}/tasks/${id}/guest-config`;
    const outputDir = `${this.config.outputRoot}/${stamp(new Date())}--${slug}--${id}`;
    for (const dir of [`${workDir}/.pi-session`, `${outputDir}/artifacts`, `${outputDir}/_control`]) mkdirSync(dir, { recursive: true });
    const events = [{ at: new Date().toISOString(), text: `task launched ${attended ? "attended" : "unattended"} from template ${template.id}` }];
    const live: Live = {
      hosts: [],
      secretHosts: [],
      shares: new Map(),
      events,
      httpResponses: [],
      httpResponsesOmitted: 0,
      httpBodyBytes: 0,
      modelRequests: 0,
      maxModelRequests: template.limits.maxModelRequests,
      modelCapNoted: false,
    };
    const keys = new Map<string, string>();
    const guestToken = randomBytes(24).toString("hex");
    // The agent's label is the task as the owner would say it: the launch name, else the template's label.
    const agent = await upstream(this.speaker.createAgent(input.name ?? template.label, `${model} · Pi on ${hostname()}`));
    let guest: Guest;
    try {
      // Speaker's proxy certificate, fetched once for the guest's trust store and bottle's own tunnel to the proxy.
      const ca = this.config.speaker.proxyPort ? await upstream(speakerCa(this.config)) : undefined;
      writeGuestConfig(guestConfigDir, this.config, this.catalog, { name, model, prompt: input.prompt, attended }, keys, [], [], []);
      guest = await this.#boot(
        this.config,
        live,
        template.limits,
        { work: workDir, artifacts: `${outputDir}/artifacts`, guestConfig: guestConfigDir, capture: `${outputDir}/_control/blobs` },
        { BOTTLE_TOKEN: guestToken, BOTTLE_CONTROL: "http://control.internal", PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
        { url: this.config.speaker.url, agentToken: agent.agentToken, ...(ca ? { ca } : {}) },
        () => speakerProxy(this.config, agent.agentToken, ca ?? ""),
      );
    } catch (error) {
      rmSync(`${this.config.stateRoot}/tasks/${id}`, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
      await this.speaker.deleteAgent(agent.id).catch(() => undefined); // the boot error is the one to report
      throw error;
    }

    const task: Task = {
      id,
      name,
      slug,
      state: "starting",
      templateId: template.id,
      attended,
      prompt: input.prompt,
      model,
      guestToken,
      agentId: agent.id,
      agentToken: agent.agentToken,
      startedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + hours * 3_600_000).toISOString(),
      workDir,
      outputDir,
      guestConfigDir,
      timers: new Set(),
      jobs: {},
      grants: [],
      mcpRunning: [],
      extRunning: [],
      events,
      live,
      guest,
      keys,
    };
    this.byId.set(id, task);
    this.byGuestToken.set(guestToken, task);
    // A launch prompt is sent once, to a fresh session: if the hosted model's key were still missing, that first turn
    // would fail for good. Pi then starts when the key arrives (#fetchProviderKey starts it with the key in place).
    const awaitKey = Boolean(input.prompt) && this.#providerSecrets(model).length > 0;
    try {
      // The template's want list is the task's first request. A hosted model's key is a speaker secret, asked for here too.
      const first = launchRequest(template, task.agentId, this.#providerSecrets(model));
      if (first) await upstream(this.speaker.request({ ...first, ...(guest.sshKey ? { sshKey: guest.sshKey } : {}) }));
      if (!awaitKey) await pi.start(guest);
    } catch (error) {
      note(live, `Pi start failed: ${(error as Error).message}`);
      this.#move(task, "fail");
      await this.close(task).catch(() => undefined); // the launch error is the one the owner needs
      throw error;
    }
    this.#move(task, awaitKey ? "wait" : "ready");
    if (input.prompt) {
      note(live, `owner launch prompt queued; archival at ${task.deadline}`);
      // A one-shot task ends when the agent writes DONE to /output; the archive records it.
      task.timers.add(
        setInterval(() => {
          if (!this.done(task)) return;
          note(live, "agent wrote DONE");
          this.close(task).catch(() => undefined); // close records a failed archive in the task state
        }, 15_000).unref(),
      );
    }
    this.#apply(task);
    task.timers.add(
      setTimeout(() => {
        note(live, "deadline reached");
        this.close(task).catch(() => undefined);
      }, hours * 3_600_000).unref(),
    );
    return task;
  }

  /** A hosted model's key is the speaker secret its provider names; a local model needs none. */
  #providerSecrets = (model: string) =>
    this.config.hostedProviders.filter((provider) => provider.id === model.split("/")[0]).map((provider) => `secret:${provider.credential}`);

  /** Whether bottle can enforce a grant: speaker's items are checked against the shared grammar, then against what this host offers. */
  #supported = (grant: Grant) => {
    const ref = refOf(grant.item);
    switch (kindOf(grant.item)) {
      case "service":
      case "folder":
        return true;
      case "secret":
        return secretHosts.safeParse(grant.hosts).success;
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

  /** Replaces every task's grants with a speaker snapshot, then reports what is in effect. */
  #onSnapshot({ grants, requests, secrets }: Snapshot) {
    this.#requests = requests;
    if (secrets) this.secrets = secrets;
    for (const task of this.byId.values()) {
      const mine = grants.filter((grant) => {
        if (grant.agentId !== task.agentId) return false;
        const supported = this.#supported(grant);
        if (!supported) note(task.live, `skipped unsupported grant ${grant.id}: ${grant.item}`);
        return supported;
      });
      const key = (set: Grant[]) => JSON.stringify(set.map((grant) => grant.id).sort());
      if (key(mine) !== key(task.grants)) {
        appendFileSync(`${task.outputDir}/_control/grants.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), grants: mine })}\n`);
        note(task.live, `grants now: ${mine.map((grant) => grant.item).join(", ") || "none"}`);
      }
      task.grants = mine;
      this.#apply(task);
      this.#fetchProviderKey(task);
    }
    this.#reportApplied();
  }

  /** Reports to speaker which grants are in force (see inForce). */
  #reportApplied() {
    this.#report(this.list().flatMap((task) => inForce(task.grants, { mcp: task.mcpRunning, ext: task.extRunning })));
  }

  /** Once the task holds its hosted model's secret, asks speaker for the placeholder and (re)starts Pi with it in models.json. */
  #fetchProviderKey(task: Task) {
    for (const item of this.#providerSecrets(task.model)) {
      const secret = item.slice("secret:".length);
      if (task.keys.has(secret) || !this.#granted(task, "secret").some((grant) => grant.item === item)) continue;
      void this.speaker
        .placeholder(task.agentToken, secret)
        .then((placeholder) => {
          task.keys.set(secret, placeholder);
          return this.#restartAtIdle(task);
        })
        .catch((error: Error) => note(task.live, `could not set up the model key ${secret}: ${error.message}`));
    }
  }

  #granted = (task: Task, kind: ItemKind) => unexpired(task.grants).filter((grant) => kindOf(grant.item) === kind);
  #wanted = (task: Task, kind: "mcp" | "ext") => {
    const known = kind === "mcp" ? this.catalog.mcps : this.catalog.extensions;
    return [...new Set(this.#granted(task, kind).map((grant) => refOf(grant.item)))].filter((id) => known[id]);
  };
  mcpPending = (task: Task) => this.#wanted(task, "mcp").filter((id) => !task.mcpRunning.includes(id));
  extPending = (task: Task) => this.#wanted(task, "ext").filter((id) => !task.extRunning.includes(id));

  /** Moves the live task view to its grants. Hosts and shares are replaced as a whole, so no grant outlives its snapshot. */
  #apply(task: Task) {
    task.live.secretHosts = this.#granted(task, "secret").map(({ item, hosts, expiresAt }) => ({
      name: refOf(item),
      hosts: secretHosts.parse(hosts),
      expiresAt,
    }));
    // A secret grant also opens egress to the hosts it names.
    task.live.hosts = [
      ...this.#granted(task, "site").map(({ item, expiresAt }) => ({ host: refOf(item), expiresAt })),
      ...task.live.secretHosts.flatMap(({ hosts, expiresAt }) => hosts.map((host) => ({ host, expiresAt }))),
    ];
    task.live.shares.clear();
    for (const { item, expiresAt } of this.#granted(task, "folder")) {
      const [share, mode] = refOf(item).split(":") as [string, string | undefined];
      if (!task.live.shares.has(share) || mode === "rw") task.live.shares.set(share, { expiresAt, writable: mode === "rw" });
    }
    // Pi loads MCP servers and extensions only at start, so a changed set restarts it at the next idle boundary.
    const changed = differs(this.#wanted(task, "mcp"), task.mcpRunning) || differs(this.#wanted(task, "ext"), task.extRunning);
    if (changed && (task.state === "idle" || task.state === "busy")) void this.#restartAtIdle(task);
  }

  /** Pi requests access from speaker directly; snapshots carry each request's status. */
  pendingRequests = (task: Task) =>
    this.#requests.filter((request) => request.agentId === task.agentId && request.status === "pending").map(({ id, what, reason }) => ({ id, what, reason }));

  done = (task: Task) => existsSync(`${task.outputDir}/artifacts/DONE`);

  /** Restarts Pi at the next idle boundary with the current configuration; a task still awaiting its key starts Pi for the first time. */
  #restartAtIdle(task: Task) {
    const run =
      task.jobs.restart ??
      (async () => {
        while (task.state === "busy" || task.state === "starting") await delay(250);
        const first = task.state === "awaiting-key";
        if (task.state !== "idle" && !first) return;
        this.#move(task, first ? "start" : "reconfigure");
        // A close may begin while Pi restarts; the restart then leaves the state alone.
        const working = first ? "starting" : "reconfiguring";
        const mcpIds = this.#wanted(task, "mcp");
        const extIds = this.#wanted(task, "ext");
        try {
          writeGuestConfig(task.guestConfigDir, this.config, this.catalog, task, task.keys, task.grants, mcpIds, extIds);
          await (first ? pi.start(task.guest) : pi.restart(task.guest));
        } catch (error) {
          note(task.live, `Pi ${first ? "start" : "restart"} failed: ${(error as Error).message}`);
          if (task.state === working) this.#move(task, "fail");
          return;
        }
        task.mcpRunning = mcpIds;
        task.extRunning = extIds;
        note(task.live, `Pi ${first ? "started" : "resumed"} with MCP servers: ${mcpIds.join(", ") || "none"}; extensions: ${extIds.join(", ") || "none"}`);
        if (task.state === working) this.#move(task, "ready");
      })().finally(() => {
        task.jobs.restart = undefined;
      });
    task.jobs.restart = run;
    // Grants may have changed during the restart; apply them again and report the new in-effect set.
    return run.then(() => {
      this.#apply(task);
      this.#reportApplied();
    });
  }

  /** Close writes trusted records before it removes only the disposable task work tree. */
  close(task: Task): Promise<void> {
    task.jobs.close ??= this.#close(task).finally(() => {
      task.jobs.close = undefined;
    });
    return task.jobs.close;
  }

  async #close(task: Task) {
    if (!this.byId.has(task.id) || closed(task)) return;
    // A task whose Pi never started has no guest session to stop or export; a task whose Pi went down has a transcript.
    const started = !neverRan(task);
    this.#move(task, "close");
    for (const timer of task.timers) clearTimeout(timer);
    note(task.live, "owner began archival");
    const modelOrigins = new Set([
      `http://${this.config.localModel.upstream}`,
      ...this.config.hostedProviders.map((provider) => new URL(provider.baseUrl).origin),
    ]);
    try {
      if (started) {
        await pi.quit(task.guest);
        for (let tries = 0; tries < 20 && (await pi.running(task.guest)); tries += 1) await delay(250);
        if (await pi.running(task.guest)) {
          note(task.live, "Pi did not exit after the grace period; killed");
          await pi.kill(task.guest);
        }
        await pi.export(task.guest);
      }
      writeArchive(task, modelOrigins, "archived");
      await task.guest.close();
      await this.speaker.deleteAgent(task.agentId);
      rmSync(`${this.config.stateRoot}/tasks/${task.id}`, { recursive: true, force: true });
      this.byId.delete(task.id);
      this.byGuestToken.delete(task.guestToken);
      this.#move(task, "archive");
    } catch (error) {
      const message = (error as Error).message;
      note(task.live, `archive failed: ${message}`);
      this.#move(task, "archiveFailed");
      // The VM and its speaker identity must not outlive the task; the work tree stays for the owner.
      try {
        writeArchive(task, modelOrigins, "failed-archive", message);
      } finally {
        await Promise.allSettled([task.guest.close(), this.speaker.deleteAgent(task.agentId)]);
      }
      throw error;
    }
  }
}

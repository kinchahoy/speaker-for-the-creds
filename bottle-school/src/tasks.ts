import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { hostname } from "node:os";
import { type Table, transition } from "../../speaker/lifecycle.ts";
import type { Config } from "./config.ts";
import { boot, note, type Boot, type Guest, type Live } from "./sandbox.ts";
import { attendedFor, folderRef, launchRequest, secretHosts, secretRef, siteRef, unexpired, type Template } from "./leases.ts";
import { availableModels, pi, writeGuestConfig, type Catalog } from "./pi.ts";
import { speakerClient, speakerProxy, watchLeases, type Lease, type SecretInfo, type Snapshot } from "./speaker.ts";
import { writeArchive } from "./trace.ts";

/**
 * A task's lifecycle. `starting` until Pi first runs; then `idle` and `busy` as the guest reports; `reconfiguring`
 * while Pi restarts with new MCP servers or extensions; `closing` while it is archived. `failed` means Pi could not
 * start or restart; a failed close ends in `failed-archive` with the work tree kept.
 */
export type TaskState = "starting" | "idle" | "busy" | "reconfiguring" | "closing" | "archived" | "failed" | "failed-archive";
type TaskEvent = "ready" | "work" | "rest" | "reconfigure" | "fail" | "close" | "archive" | "archiveFailed";
const taskTable: Table<TaskState, TaskEvent> = {
  starting: { ready: "idle", fail: "failed", close: "closing" },
  idle: { work: "busy", rest: "idle", reconfigure: "reconfiguring", close: "closing" },
  busy: { work: "busy", rest: "idle", close: "closing" },
  reconfiguring: { ready: "idle", fail: "failed", close: "closing" },
  failed: { close: "closing" },
  closing: { archive: "archived", archiveFailed: "failed-archive" },
  archived: {},
  "failed-archive": {},
};
const closed = (task: Task) => ["closing", "archived", "failed-archive"].includes(task.state);

export type Task = {
  id: string;
  name: string;
  slug: string;
  state: TaskState;
  templateId: string;
  /** The owner answers questions at the terminal; see attendedFor. */
  attended: boolean;
  model: string;
  token: string;
  subjectId: string;
  /** The task's agent token at speaker. It stays on the host: the guest only has a placeholder for it. */
  speakerToken: string;
  startedAt: string;
  deadline: string;
  workDir: string;
  outputDir: string;
  guestConfigDir: string;
  prompt?: string;
  lastMessage?: string;
  lastMessageAt?: string;
  doneWatch?: NodeJS.Timeout;
  /** The latest speaker snapshot for this task's subject. */
  leases: Lease[];
  /** The MCP servers Pi started with. */
  mcpRunning: string[];
  /** The catalog extensions Pi started with. */
  extensionsRunning: string[];
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
export const inForce = (leases: Lease[], running: { mcp: string[]; extensions: string[] }) =>
  unexpired(leases)
    .filter(
      (lease) =>
        (lease.kind !== "mcp" || running.mcp.includes(lease.ref)) &&
        (lease.kind !== "extension" || running.extensions.includes(lease.ref)),
    )
    .map((lease) => lease.id);

export class Tasks {
  readonly byId = new Map<string, Task>();
  readonly byToken = new Map<string, Task>();
  readonly #closing = new Map<string, Promise<void>>();
  readonly #reconfiguring = new Map<string, Promise<void>>();
  readonly #report: ReturnType<typeof watchLeases>;
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
    this.#report = watchLeases(
      config,
      hostToken,
      (snapshot) => this.#onSnapshot(snapshot),
      // Without speaker no lease can apply: stop through the normal shutdown (archives tasks) and exit nonzero.
      (message) => {
        console.error(`stopping bottle-school: ${message}`);
        process.exitCode = 1;
        process.kill(process.pid, "SIGTERM");
      },
    );
  }

  list = () => [...this.byId.values()];
  /** Closes the connection to speaker (the tasks stay as they are). */
  stop = () => this.#report.stop();
  get = (id: string) => {
    const task = this.byId.get(id);
    if (!task) throw new Error(`no active task ${id}`);
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
    if (this.list().filter((task) => !closed(task)).length >= this.config.maxTasks)
      throw new Error(`already running ${this.config.maxTasks} tasks`);
    const template = this.templates.get(input.template);
    if (!template) throw new Error(`no template ${input.template}`);
    const attended = attendedFor(template, input);
    const name = input.name ?? template.id;
    const model = input.model ?? `local/${this.config.localModel.models[0]!.id}`;
    const models = availableModels(this.config).map((entry) => entry.id);
    if (!models.includes(model)) throw new Error(`model ${model} is not configured; use one of: ${models.join(", ")}`);
    const hours = input.hours ?? template.limits.maxRuntimeHours;
    if (hours > template.limits.maxRuntimeHours)
      throw new Error(`template ${template.id} limits a task to ${template.limits.maxRuntimeHours} hours`);
    for (const [root, GiB, label] of [[this.config.stateRoot, template.limits.workGiB, "state"], [this.config.outputRoot, 1, "output"]] as const) {
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
    const token = randomBytes(24).toString("hex");
    // The agent's label is the task as the owner would say it: the launch name, else the template's label.
    const subject = await this.speaker.createAgent(input.name ?? template.label, `${model} · Pi on ${hostname()}`);
    let guest: Guest;
    try {
      writeGuestConfig(guestConfigDir, this.config, this.catalog, { name, model, prompt: input.prompt, attended }, keys, [], [], [], this.secrets);
      guest = await this.#boot(
        this.config,
        live,
        template.limits,
        { work: workDir, artifacts: `${outputDir}/artifacts`, guestConfig: guestConfigDir, capture: `${outputDir}/_control/blobs` },
        { PI_V2_TOKEN: token, PI_V2_CONTROL: "http://control.internal", PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
        { url: this.config.speaker.url, token: subject.token },
        () => speakerProxy(this.config, subject.token),
      );
    } catch (error) {
      rmSync(`${this.config.stateRoot}/tasks/${id}`, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
      await this.speaker.deleteAgent(subject.id).catch(() => undefined); // the boot error is the one to report
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
      token,
      subjectId: subject.id,
      speakerToken: subject.token,
      startedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + hours * 3_600_000).toISOString(),
      workDir,
      outputDir,
      guestConfigDir,
      leases: [],
      mcpRunning: [],
      extensionsRunning: [],
      events,
      live,
      guest,
      keys,
    };
    this.byId.set(id, task);
    this.byToken.set(token, task);
    try {
      // The template's want list is the task's first request. A hosted model's key is a speaker secret, asked for here too.
      const first = launchRequest(template, task.subjectId, this.#providerSecrets(model));
      if (first) await this.speaker.request({ ...first, ...(guest.sshKey ? { sshKey: guest.sshKey } : {}) });
      // A launch prompt is sent once, to a fresh session: if the hosted model's key were still missing, that first turn
      // would fail for good. Pi then starts when the key arrives (#fetchProviderKey restarts it with the key in place).
      if (!(input.prompt && this.#providerSecrets(model).length)) await pi.start(guest);
    } catch (error) {
      note(live, `Pi start failed: ${(error as Error).message}`);
      this.#move(task, "fail");
      await this.close(task).catch(() => undefined); // the launch error is the one the owner needs
      throw error;
    }
    this.#move(task, "ready");
    if (input.prompt) {
      note(live, `owner launch prompt queued; archival at ${task.deadline}`);
      // A one-shot task ends when the agent writes DONE to /output; the archive records it.
      task.doneWatch = setInterval(() => {
        if (!this.done(task)) return;
        note(live, "agent wrote DONE");
        this.close(task).catch(() => undefined); // close records a failed archive in the task state
      }, 15_000).unref();
    }
    this.#apply(task);
    setTimeout(() => {
      note(live, "deadline reached");
      void this.close(task);
    }, hours * 3_600_000).unref();
    return task;
  }

  /** A hosted model's key is the speaker secret its provider names; a local model needs none. */
  #providerSecrets = (model: string) =>
    this.config.hostedProviders.filter((provider) => provider.id === model.split("/")[0]).map((provider) => `secret:${provider.credential}`);

  /** Replaces every task's leases with a speaker snapshot, then reports what is in effect. */
  #onSnapshot({ leases, requests, secrets }: Snapshot) {
    this.#requests = requests;
    if (secrets) this.secrets = secrets;
    for (const task of this.byId.values()) {
      const mine = leases.filter((lease) => {
        if (lease.subjectId !== task.subjectId) return false;
        const valid =
          lease.kind === "credential" ||
          (lease.kind === "secret" && secretRef.safeParse(lease.ref).success && secretHosts.safeParse(lease.hosts).success) ||
          (lease.kind === "folder" && folderRef.safeParse(lease.ref).success) ||
          (lease.kind === "site" && siteRef.safeParse(lease.ref).success) ||
          (lease.kind === "mcp" && Object.hasOwn(this.catalog.mcps, lease.ref)) ||
          (lease.kind === "extension" && Object.hasOwn(this.catalog.extensions, lease.ref));
        if (!valid) note(task.live, `skipped unsupported lease ${lease.id}: ${lease.kind} ${lease.ref}`);
        return valid;
      });
      const key = (set: Lease[]) => JSON.stringify(set.map((lease) => lease.id).sort());
      if (key(mine) !== key(task.leases)) {
        appendFileSync(`${task.outputDir}/_control/leases.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), leases: mine })}\n`);
        note(task.live, `leases now: ${mine.map((lease) => `${lease.kind} ${lease.ref}`).join(", ") || "none"}`);
      }
      task.leases = mine;
      this.#apply(task);
      this.#fetchProviderKey(task);
    }
    this.#reportApplied();
  }

  /** Reports to speaker which grants are in force (see inForce). */
  #reportApplied() {
    this.#report(this.list().flatMap((task) => inForce(task.leases, { mcp: task.mcpRunning, extensions: task.extensionsRunning })));
  }

  /** Once the task holds its hosted model's secret, asks speaker for the placeholder and restarts Pi with it in models.json. */
  #fetchProviderKey(task: Task) {
    for (const item of this.#providerSecrets(task.model)) {
      const secret = item.slice("secret:".length);
      if (task.keys.has(secret) || !this.#leased(task, "secret").some((lease) => lease.ref === secret)) continue;
      void this.speaker
        .placeholder(task.speakerToken, secret)
        .then((placeholder) => {
          task.keys.set(secret, placeholder);
          return this.#restartAtIdle(task);
        })
        .catch((error: Error) => note(task.live, `could not set up the model key ${secret}: ${error.message}`));
    }
  }

  #leased = (task: Task, kind: string) => unexpired(task.leases).filter((lease) => lease.kind === kind);
  #wanted = (task: Task, kind: "mcp" | "extension") => {
    const known = kind === "mcp" ? this.catalog.mcps : this.catalog.extensions;
    return [...new Set(this.#leased(task, kind).map((lease) => lease.ref))].filter((id) => known[id]);
  };
  mcpPending = (task: Task) => this.#wanted(task, "mcp").filter((id) => !task.mcpRunning.includes(id));
  extensionsPending = (task: Task) => this.#wanted(task, "extension").filter((id) => !task.extensionsRunning.includes(id));

  /** Moves the live task view to its leases. Hosts and shares are replaced as a whole, so no lease outlives its snapshot. */
  #apply(task: Task) {
    task.live.secretHosts = this.#leased(task, "secret").map(({ ref, hosts, expiresAt }) => ({ name: ref, hosts: secretHosts.parse(hosts), expiresAt }));
    // A secret lease also opens egress to the hosts it names.
    task.live.hosts = [
      ...this.#leased(task, "site").map(({ ref, expiresAt }) => ({ host: ref, expiresAt })),
      ...task.live.secretHosts.flatMap(({ hosts, expiresAt }) => hosts.map((host) => ({ host, expiresAt }))),
    ];
    task.live.shares.clear();
    for (const { ref, expiresAt } of this.#leased(task, "folder")) {
      const [share, mode] = ref.split(":") as [string, string | undefined];
      if (!task.live.shares.has(share) || mode === "rw") task.live.shares.set(share, { expiresAt, writable: mode === "rw" });
    }
    // Pi loads MCP servers and extensions only at start, so a changed set restarts it at the next idle boundary.
    const changed = differs(this.#wanted(task, "mcp"), task.mcpRunning) || differs(this.#wanted(task, "extension"), task.extensionsRunning);
    if (changed && (task.state === "idle" || task.state === "busy")) void this.#restartAtIdle(task);
  }

  /** Pi requests access from speaker directly; snapshots carry each request's status. */
  pendingRequests = (task: Task) =>
    this.#requests
      .filter((request) => request.subjectId === task.subjectId && request.status === "pending")
      .map(({ id, what, reason }) => ({ id, what, reason }));

  done = (task: Task) => existsSync(`${task.outputDir}/artifacts/DONE`);

  #restartAtIdle(task: Task) {
    const run =
      this.#reconfiguring.get(task.id) ??
      (async () => {
        while (task.state === "busy" || task.state === "starting") await delay(250);
        if (task.state !== "idle") return;
        this.#move(task, "reconfigure");
        // A close may begin while Pi restarts; the restart then leaves the state alone.
        const reconfiguring = () => task.state === "reconfiguring";
        const mcpIds = this.#wanted(task, "mcp");
        const extensionIds = this.#wanted(task, "extension");
        try {
          writeGuestConfig(task.guestConfigDir, this.config, this.catalog, task, task.keys, task.leases, mcpIds, extensionIds, this.secrets);
          await pi.restart(task.guest);
        } catch (error) {
          note(task.live, `Pi restart failed: ${(error as Error).message}`);
          if (reconfiguring()) this.#move(task, "fail");
          return;
        }
        task.mcpRunning = mcpIds;
        task.extensionsRunning = extensionIds;
        note(task.live, `Pi resumed with MCP servers: ${mcpIds.join(", ") || "none"}; extensions: ${extensionIds.join(", ") || "none"}`);
        if (reconfiguring()) this.#move(task, "ready");
      })().finally(() => this.#reconfiguring.delete(task.id));
    this.#reconfiguring.set(task.id, run);
    // Leases may have changed during the restart; apply them again and report the new in-effect set.
    return run.then(() => {
      this.#apply(task);
      this.#reportApplied();
    });
  }

  abort = async (task: Task) => {
    if (closed(task)) throw new Error(`task ${task.id} is closed`);
    note(task.live, "owner sent Pi an interrupt");
    return pi.abort(task.guest);
  };

  restart = (task: Task) => {
    note(task.live, "owner queued a Pi restart");
    return this.#restartAtIdle(task);
  };

  /** Close writes trusted records before it removes only the disposable task work tree. */
  close(task: Task): Promise<void> {
    const run = this.#closing.get(task.id) ?? this.#close(task).finally(() => this.#closing.delete(task.id));
    this.#closing.set(task.id, run);
    return run;
  }

  async #close(task: Task) {
    if (!this.byId.has(task.id) || closed(task)) return;
    // A task whose Pi never started has no guest session to stop or export; each guest call would only time out.
    const started = task.state !== "failed";
    this.#move(task, "close");
    clearInterval(task.doneWatch);
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
      await this.speaker.deleteAgent(task.subjectId);
      rmSync(`${this.config.stateRoot}/tasks/${task.id}`, { recursive: true, force: true });
      this.byId.delete(task.id);
      this.byToken.delete(task.token);
      this.#move(task, "archive");
    } catch (error) {
      const message = (error as Error).message;
      note(task.live, `archive failed: ${message}`);
      this.#move(task, "archiveFailed");
      // The VM and its speaker identity must not outlive the task; the work tree stays for the owner.
      try {
        writeArchive(task, modelOrigins, "failed-archive", message);
      } finally {
        await Promise.allSettled([task.guest.close(), this.speaker.deleteAgent(task.subjectId)]);
      }
      throw error;
    }
  }
}

import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { statfs } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { hostname } from "node:os";
import type { Config } from "./config.ts";
import { note, type CapturedBody, type Guest, type Live } from "./backend.ts";
import { backends } from "./backends/index.ts";
import { attendedFor, folderRef, launchRequest, secretHosts, secretRef, siteRef, unexpired, type Template } from "./leases.ts";
import { availableModels, pi, writeGuestConfig, type Catalog } from "./pi.ts";
import { speakerClient, speakerProxy, watchLeases, type Lease, type SecretInfo, type Snapshot } from "./speaker.ts";
import { assembleStream, createModelRuns, createToolRuns } from "./trace-runs.ts";

export type TaskState =
  | "starting"
  | "idle"
  | "busy"
  | "reconfiguring"
  | "closing"
  | "archived"
  | "failed"
  | "failed-archive";
export type TaskEvent = { at: string; text: string };

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
  events: TaskEvent[];
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

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

type Entry = {
  path: string;
  bytes?: number;
  sha256?: string;
  type: "file" | "directory" | "symlink" | "other";
};

/** Agent-created links never make the trusted archiver follow paths outside artifacts. */
const walk = (root: string, prefix = ""): Entry[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry): Entry[] => {
    const path = `${root}/${entry.name}`;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return [{ path: relative, type: "directory" }, ...walk(path, relative)];
    if (entry.isFile())
      return [{ path: relative, bytes: lstatSync(path).size, sha256: sha256(path), type: "file" }];
    return [{ path: relative, type: entry.isSymbolicLink() ? "symlink" : "other" }];
  });

const isClosed = (task: Task) =>
  task.state === "closing" || task.state === "archived" || task.state === "failed-archive";

const taskRecord = (
  task: Task,
  closeStatus: "archived" | "failed-archive",
  closedAt: string,
  error?: string,
) => ({
  id: task.id,
  name: task.name,
  slug: task.slug,
  state: closeStatus,
  templateId: task.templateId,
  attended: task.attended,
  subjectId: task.subjectId,
  model: task.model,
  startedAt: task.startedAt,
  deadline: task.deadline,
  closedAt,
  ...(error ? { error } : {}),
});

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
  readonly #report: (leaseIds: string[]) => void;
  #requests: Snapshot["requests"] = [];

  config: Config;
  templates: Map<string, Template>;
  catalog: Catalog;
  /** The secrets the owner set up in speaker, as the last snapshot listed them (names and hosts, never values). */
  secrets: SecretInfo[] = [];
  speaker: ReturnType<typeof speakerClient>;

  constructor(config: Config, templates: Map<string, Template>, catalog: Catalog, hostToken: string) {
    this.config = config;
    this.templates = templates;
    this.catalog = catalog;
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
  get = (id: string) => {
    const task = this.byId.get(id);
    if (!task) throw new Error(`no active task ${id}`);
    return task;
  };

  #event(task: Task, text: string) {
    note(task.live, text);
  }

  async #checkSpace(path: string, requiredGiB: number, label: string) {
    const disk = await statfs(path);
    if (disk.bavail * disk.bsize < requiredGiB * 1024 ** 3)
      throw new Error(`the ${label} filesystem has less than ${requiredGiB} GiB free`);
  }

  async create(input: {
    name?: string;
    template: string;
    model?: string;
    prompt?: string;
    attended?: boolean;
    hours?: number;
  }): Promise<Task> {
    // Closed and failed-archive tasks stay listed for the owner but no longer hold a slot.
    if ([...this.byId.values()].filter((task) => !isClosed(task)).length >= this.config.maxTasks)
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
      throw new Error(
        `template ${template.id} limits a task to ${template.limits.maxRuntimeHours} hours`,
      );
    await this.#checkSpace(this.config.stateRoot, template.limits.workGiB, "state");
    await this.#checkSpace(this.config.outputRoot, 1, "output");

    const id = randomBytes(4).toString("hex");
    const slug = slugify(name);
    const workDir = `${this.config.stateRoot}/tasks/${id}/work`;
    const guestConfigDir = `${this.config.stateRoot}/tasks/${id}/guest-config`;
    const outputDir = `${this.config.outputRoot}/${stamp(new Date())}--${slug}--${id}`;
    mkdirSync(`${workDir}/.pi-session`, { recursive: true });
    mkdirSync(`${outputDir}/artifacts`, { recursive: true });
    mkdirSync(`${outputDir}/_control`, { recursive: true });

    const events: TaskEvent[] = [
      {
        at: new Date().toISOString(),
        text: `task launched ${attended ? "attended" : "unattended"} from template ${template.id}`,
      },
    ];
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
    let registered = false;
    try {
      writeGuestConfig(
        guestConfigDir,
        this.config,
        this.catalog,
        { name, model, prompt: input.prompt, attended },
        keys,
        [],
        [],
        [],
        this.secrets,
      );
      const guest = await backends[this.config.backend].boot(
        this.config,
        live,
        template.limits,
        {
          work: workDir,
          artifacts: `${outputDir}/artifacts`,
          guestConfig: guestConfigDir,
          capture: `${outputDir}/_control/blobs`,
        },
        {
          PI_V2_TOKEN: token,
          PI_V2_CONTROL: "http://control.internal",
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          PI_SKIP_VERSION_CHECK: "1",
        },
        { url: this.config.speaker.url, token: subject.token },
        () => speakerProxy(this.config, subject.token),
      );

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
      registered = true;
      try {
        // The template's want list is the task's first request. A hosted model's key is a speaker secret, asked for here too.
        const first = launchRequest(template, task.subjectId, this.#providerSecrets(model));
        if (first) await this.speaker.request(first);
        // A launch prompt is sent once, to a fresh session: if the hosted model's key were still missing, that first turn
        // would fail for good. Pi then starts when the key arrives (#fetchProviderKey restarts it with the key in place).
        if (!(input.prompt && this.#providerSecrets(model).length)) await pi.start(guest);
        task.state = "idle";
        if (input.prompt)
          this.#event(task, `owner launch prompt queued; archival at ${task.deadline}`);
        this.#apply(task);
        if (input.prompt) this.#watchDone(task);
        setTimeout(() => {
          this.#event(task, "deadline reached");
          void this.close(task);
        }, hours * 3_600_000).unref();
        return task;
      } catch (error) {
        this.#event(task, `Pi start failed: ${(error as Error).message}`);
        task.state = "failed";
        await this.close(task).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!registered) {
        rmSync(`${this.config.stateRoot}/tasks/${id}`, { recursive: true, force: true });
        rmSync(outputDir, { recursive: true, force: true });
        await this.speaker.deleteAgent(subject.id).catch(() => undefined);
      }
      throw error;
    }
  }

  /** A hosted model's key is the speaker secret its provider names; a local model needs none. */
  #providerSecrets = (model: string) =>
    this.config.hostedProviders
      .filter((provider) => provider.id === model.split("/")[0])
      .map((provider) => `secret:${provider.credential}`);

  /** Replaces every task's leases with a speaker snapshot, then reports what is in effect. */
  #onSnapshot({ leases, requests, secrets }: Snapshot) {
    this.#requests = requests;
    if (secrets) this.secrets = secrets;
    for (const task of this.byId.values()) {
      const mine = leases.filter((lease) => {
        if (lease.subjectId !== task.subjectId) return false;
        if (lease.kind === "folder" && !backends[this.config.backend].folders) {
          this.#event(task, `refused folder ${lease.ref}: folders are not available on the ${this.config.backend} backend yet`);
          return false;
        }
        const valid = lease.kind === "credential" ||
          (lease.kind === "secret" && secretRef.safeParse(lease.ref).success && secretHosts.safeParse(lease.hosts).success) ||
          (lease.kind === "folder" && folderRef.safeParse(lease.ref).success && Object.hasOwn(this.config.shareRoots, lease.ref.split(":")[0]!)) ||
          (lease.kind === "site" && siteRef.safeParse(lease.ref).success) ||
          (lease.kind === "mcp" && Object.hasOwn(this.catalog.mcps, lease.ref)) ||
          (lease.kind === "extension" && Object.hasOwn(this.catalog.extensions, lease.ref));
        if (!valid) this.#event(task, `skipped unsupported lease ${lease.id}: ${lease.kind} ${lease.ref}`);
        return valid;
      });
      const key = (set: Lease[]) => JSON.stringify(set.map((lease) => lease.id).sort());
      if (key(mine) !== key(task.leases)) {
        appendFileSync(
          `${task.outputDir}/_control/leases.jsonl`,
          `${JSON.stringify({ at: new Date().toISOString(), leases: mine })}\n`,
        );
        this.#event(task, `leases now: ${mine.map((lease) => `${lease.kind} ${lease.ref}`).join(", ") || "none"}`);
      }
      task.leases = mine;
      this.#apply(task);
      this.#fetchProviderKey(task);
    }
    this.#reportApplied();
  }

  /** Reports to speaker which grants are in force (see inForce). */
  #reportApplied() {
    this.#report(
      this.list().flatMap((task) =>
        inForce(task.leases, { mcp: task.mcpRunning, extensions: task.extensionsRunning }),
      ),
    );
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
        .catch((error: Error) => this.#event(task, `could not set up the model key ${secret}: ${error.message}`));
    }
  }

  mcpPending = (task: Task) =>
    this.#leased(task, "mcp")
      .map((lease) => lease.ref)
      .filter((id) => this.catalog.mcps[id] && !task.mcpRunning.includes(id));

  extensionsPending = (task: Task) =>
    this.#wantedExtensions(task).filter((id) => !task.extensionsRunning.includes(id));

  #wantedMcps = (task: Task) =>
    [...new Set(this.#leased(task, "mcp").map((lease) => lease.ref))].filter((id) => this.catalog.mcps[id]);
  #wantedExtensions = (task: Task) =>
    [...new Set(this.#leased(task, "extension").map((lease) => lease.ref))].filter((id) => this.catalog.extensions[id]);

  #leased = (task: Task, kind: string) => unexpired(task.leases).filter((lease) => lease.kind === kind);

  /** Moves the live task view to its leases. Hosts and shares are replaced as a whole, so no lease outlives its snapshot. */
  #apply(task: Task) {
    const hosts = this.#leased(task, "site").map(({ ref, expiresAt }) => ({ host: ref, expiresAt }));
    task.live.secretHosts = this.#leased(task, "secret").map(({ ref, hosts, expiresAt }) => ({
      name: ref,
      hosts: secretHosts.parse(hosts),
      expiresAt,
    }));
    // A secret lease also opens egress to the hosts it names.
    for (const secret of task.live.secretHosts)
      for (const host of secret.hosts) hosts.push({ host, expiresAt: secret.expiresAt });
    task.live.hosts = hosts;

    task.live.shares.clear();
    for (const { ref, expiresAt } of this.#leased(task, "folder")) {
      const [share, mode] = ref.split(":");
      const root = this.config.shareRoots[share!];
      if (!root) {
        this.#event(task, `folder lease names unknown share ${share}`);
        continue;
      }
      if (task.live.shares.has(share!) && mode !== "rw") continue;
      task.live.shares.set(share!, { expiresAt, root, writable: mode === "rw" });
    }

    // Pi loads MCP servers and extensions only at start, so a changed set restarts it at the next idle boundary.
    const differs = (wanted: string[], running: string[]) =>
      wanted.length !== running.length || wanted.some((id) => !running.includes(id));
    const changed =
      differs(this.#wantedMcps(task), task.mcpRunning) ||
      differs(this.#wantedExtensions(task), task.extensionsRunning);
    if (changed && (task.state === "idle" || task.state === "busy")) void this.#restartAtIdle(task);
  }

  /** Pi requests access from speaker directly; snapshots carry each request's status. */
  pendingRequests = (task: Task) =>
    this.#requests
      .filter((request) => request.subjectId === task.subjectId && request.status === "pending")
      .map(({ id, what, reason }) => ({ id, what, reason }));

  /** A one-shot task ends when the agent writes DONE to /output. The archive then records it. */
  #watchDone(task: Task) {
    task.doneWatch = setInterval(() => {
      if (!this.done(task)) return;
      this.#event(task, "agent wrote DONE");
      this.close(task).catch(() => undefined); // close records a failed archive in the task state
    }, 15_000).unref();
  }

  done = (task: Task) => existsSync(`${task.outputDir}/artifacts/DONE`);

  #restartAtIdle(task: Task) {
    const existing = this.#reconfiguring.get(task.id);
    if (existing) return existing;
    const run = (async () => {
      while (task.state === "busy") await delay(250);
      if (isClosed(task) || task.state === "failed") return;
      task.state = "reconfiguring";
      try {
        const mcpIds = this.#wantedMcps(task);
        const extensionIds = this.#wantedExtensions(task);
        writeGuestConfig(
          task.guestConfigDir,
          this.config,
          this.catalog,
          task,
          task.keys,
          task.leases,
          mcpIds,
          extensionIds,
          this.secrets,
        );
        await pi.restart(task.guest);
        task.mcpRunning = mcpIds;
        task.extensionsRunning = extensionIds;
        this.#event(
          task,
          `Pi resumed with MCP servers: ${mcpIds.join(", ") || "none"}; extensions: ${extensionIds.join(", ") || "none"}`,
        );
        task.state = "idle";
      } catch (error) {
        this.#event(task, `Pi restart failed: ${(error as Error).message}`);
        task.state = "failed";
      }
    })().finally(() => this.#reconfiguring.delete(task.id));
    this.#reconfiguring.set(task.id, run);
    // Leases may have changed during the restart; apply them again and report the new in-effect set.
    return run.then(() => {
      this.#apply(task);
      this.#reportApplied();
    });
  }

  abort = async (task: Task) => {
    if (isClosed(task)) throw new Error(`task ${task.id} is closed`);
    this.#event(task, "owner sent Pi an interrupt");
    return pi.abort(task.guest);
  };

  restart = (task: Task) => {
    this.#event(task, "owner queued a Pi restart");
    return this.#restartAtIdle(task);
  };

  /** Close writes trusted records before it removes only the disposable task work tree. */
  close(task: Task): Promise<void> {
    const existing = this.#closing.get(task.id);
    if (existing) return existing;
    const run = this.#close(task).finally(() => this.#closing.delete(task.id));
    this.#closing.set(task.id, run);
    return run;
  }

  async #close(task: Task) {
    if (!this.byId.has(task.id)) return;
    // A task whose Pi never started has no guest session to stop or export; each guest call would only time out.
    const started = task.state !== "failed";
    task.state = "closing";
    clearInterval(task.doneWatch);
    this.#event(task, "owner began archival");
    try {
      if (started) {
        await pi
          .quit(task.guest)
          .catch((error: Error) => this.#event(task, `Pi quit request failed: ${error.message}`));
        for (let tries = 0; tries < 20 && (await pi.running(task.guest)); tries += 1)
          await delay(250);
        if (await pi.running(task.guest)) {
          this.#event(task, "Pi did not exit after the grace period; killed");
          await pi.kill(task.guest);
        }
        await pi.export(task.guest);
      }
      this.#writeArchive(task, "archived");
      await task.guest.close();
      await this.speaker.deleteAgent(task.subjectId);
      rmSync(`${this.config.stateRoot}/tasks/${task.id}`, { recursive: true, force: true });
      this.byId.delete(task.id);
      this.byToken.delete(task.token);
      task.state = "archived";
    } catch (error) {
      const message = (error as Error).message;
      this.#event(task, `archive failed: ${message}`);
      task.state = "failed-archive";
      try {
        this.#writeArchive(task, "failed-archive", message);
      } catch {
        /* Keep the work tree when even the trusted record cannot be written. */
      }
      await task.guest.close().catch(() => undefined);
      // The VM is gone; its speaker identity must not outlive it. The work tree stays for the owner.
      await this.speaker.deleteAgent(task.subjectId).catch(() => undefined);
      throw error;
    }
  }

  #writeArchive(task: Task, status: "archived" | "failed-archive", error?: string) {
    const control = `${task.outputDir}/_control`;
    const closedAt = new Date().toISOString();
    const session = `${task.workDir}/.pi-session/task.jsonl`;
    const transcript = `${task.workDir}/transcript.html`;
    const hasSession = existsSync(session);
    const nativeRecords = hasSession
      ? readFileSync(session, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    if (hasSession) copyFileSync(session, `${control}/pi-session.jsonl`);
    else this.#event(task, "Pi session file was unavailable during archival");
    if (existsSync(transcript)) copyFileSync(transcript, `${control}/transcript.html`);
    else this.#event(task, "Pi transcript export was unavailable during archival");
    const traceId = randomUUID();
    const harnessRunId = randomUUID();
    const sessionId = nativeRecords.find((record) => record.type === "session")?.id;
    const toolTrace = createToolRuns(nativeRecords, {
      sessionId,
      taskId: task.id,
      traceId,
      parentRunId: harnessRunId,
    });
    const modelOrigins = new Set([
      `http://${this.config.localModel.upstream}`,
      ...this.config.hostedProviders.map((provider) => new URL(provider.baseUrl).origin),
    ]);
    // trace.jsonl is the master record: it embeds each captured body, and the blob files go away after it is written.
    // A streamed model reply is stored as its finished message; the per-token event stream is dropped.
    const embed = ({ path, ...body }: CapturedBody, content: boolean) => {
      if (!content) return body;
      const bytes = readFileSync(`${control}/${path}`);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { ...body, base64: bytes.toString("base64") };
      }
      return text.startsWith("data: ") && !body.truncated
        ? { ...body, format: "assembled_stream", message: assembleStream(text) }
        : { ...body, text };
    };
    // Model runs carry their bodies; the project run keeps only metadata for those exchanges.
    const httpRecords = (content: (destination: string) => boolean) =>
      task.live.httpResponses.map(({ requestBody, responseBody, ...record }) => ({
        ...record,
        ...(requestBody ? { requestBody: embed(requestBody, content(record.destination)) } : {}),
        ...(responseBody ? { responseBody: embed(responseBody, content(record.destination)) } : {}),
      }));
    const modelRuns = createModelRuns(
      httpRecords(() => true),
      {
        modelOrigins,
        model: task.model,
        taskId: task.id,
        traceId,
      },
    );
    const projectRun = {
      id: traceId,
      name: task.name,
      run_type: "chain",
      trace_id: traceId,
      start_time: task.startedAt,
      end_time: closedAt,
      inputs: {},
      outputs: { close_status: status },
      extra: {
        metadata: {
          thread_id: task.id,
          broker: {
            schema_version: 1,
            source: "broker",
            capture_status: "native_and_http_runs",
            http_body_bytes: task.live.httpBodyBytes,
            http_responses: httpRecords((destination) => !modelOrigins.has(destination)),
            http_responses_omitted: task.live.httpResponsesOmitted,
          },
        },
      },
    };
    const harnessRun = {
      id: harnessRunId,
      name: "pi",
      run_type: "chain",
      trace_id: traceId,
      parent_run_id: traceId,
      start_time: task.startedAt,
      end_time: closedAt,
      inputs: {},
      outputs: { native_record_count: nativeRecords.length },
      extra: {
        metadata: {
          thread_id: task.id,
          broker: {
            schema_version: 1,
            source: "harness",
            harness: "pi",
            capture_status: hasSession ? "source_file_present" : "source_file_missing",
            native_records: toolTrace.unassignedRecords,
          },
        },
      },
    };
    writeFileSync(
      `${control}/trace.jsonl`,
      [projectRun, harnessRun, ...modelRuns, ...toolTrace.runs]
        .map((run) => JSON.stringify(run))
        .join("\n") + "\n",
    );
    writeFileSync(
      `${control}/task.json`,
      JSON.stringify(taskRecord(task, status, closedAt, error), null, 2),
    );
    writeFileSync(
      `${control}/policy-events.jsonl`,
      task.events.map((event) => JSON.stringify(event)).join("\n"),
    );
    const files = walk(`${task.outputDir}/artifacts`);
    writeFileSync(
      `${control}/manifest.json`,
      JSON.stringify(
        { closed: status === "archived", files, ...(error ? { error } : {}) },
        null,
        2,
      ),
    );
    rmSync(`${control}/blobs`, { recursive: true, force: true });
  }
}

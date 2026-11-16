#!/usr/bin/env node
import { execFile, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { hc as honoClient } from "hono/client";
import { Command, InvalidArgumentError, Option } from "commander";
import { z } from "zod";
import { attach } from "./sandbox.ts";
import type { ControlApi } from "./server.ts";
import { registerHost } from "./speaker.ts";
import { bottleHome, configPathFromEnv, controlOrigin, loadConfig, localModelUp, type Config } from "./config.ts";
import { givenAtLaunch, loadTemplates } from "./grants.ts";
import { availableModels, loadCatalog } from "./pi.ts";
import { finishedAgents } from "./agents.ts";

/** The owner's terminal client: `bottle run | ls | attach | stop | down | serve | build | register`. */
type Agent = {
  id: string;
  name: string;
  /** Short task title written by the agent: untrusted text. */
  title?: string;
  state: string;
  attended?: boolean;
  model?: string;
  startedAt?: string;
  sessionId: string;
  pendingRequests: { id: string; what: string; reason: string }[];
  launchGrants: string[];
  done: boolean;
  summary?: string;
};

// mise names the task it runs; installed on PATH, the command is plain `bottle`.
const SELF = process.env.MISE_TASK_NAME === undefined ? "bottle" : "mise run bottle";
const root = resolve(import.meta.dirname, "../..");
const configPath = configPathFromEnv();

/** Host commands backed by the package's shell scripts; their arguments pass through unchanged. */
const SCRIPTS = { serve: "start.sh", build: "guest/build.sh" } as const;
type Script = keyof typeof SCRIPTS;

const runScript = (name: Script, args: string[]) => {
  const child = spawn(join(import.meta.dirname, "..", SCRIPTS[name]), args, { stdio: "inherit" });
  // The terminal's Ctrl-C reaches the script too; stay alive until it has cleaned up, and pass on a TERM.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("error", (error) => {
    console.error(`error: could not run ${SCRIPTS[name]}: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 1));
};

type Values = {
  folder?: string[];
  json?: boolean;
  name?: string;
  template?: string;
  model?: string;
  hours?: number;
  detach?: boolean;
  attended?: boolean;
  unattended?: boolean;
};
type Command_ = "templates" | "register" | "run" | "ls" | "attach" | "stop" | "down";

const home = bottleHome();
const logFile = join(home, "bottle.log");
const pidFile = join(home, "bottle.pid");
const START_WAIT_MS = 60_000;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const ATTACHABLE = ["starting", "idle", "busy", "reconfiguring"];
const CLOSED = ["closing", "archived", "failed-archive"];
const attachCommand = (id: string) => (SELF === "bottle" ? `bottle attach ${id}` : `cd '${root}' && ${SELF} attach ${id}`);

/** What the owner reads after Pi quits: the agent (its VM, files, and grants) is still up; only Pi is not. */
const piQuit = (id: string) =>
  `Pi quit, but agent ${id} is still running: its VM, files, and grants are kept. ${SELF} attach ${id} restarts Pi on the same session; ${SELF} stop ${id} archives the agent and shuts its VM down.`;

/** Whether Pi still runs in the guest: dtach removes its socket when Pi exits (the owner quit it). */
const piRunning = (agent: Agent) => {
  const check = attach(agent.sessionId, ["test", "-S", "/run/pi.dtach"]);
  return spawnSync(check.file, check.args).status === 0;
};

/** Pi's terminal in the VM, here; resolves when the owner detaches (Ctrl-\\) or Pi's session ends. */
const attachHere = (agent: Agent) =>
  new Promise<void>((done, fail) => {
    console.error(`Attaching to ${agent.name} (${agent.id}). Ctrl-\\ detaches, and Pi keeps running.`);
    // dtach's default redraw sends Ctrl-L, which is Pi's model selector; a resize signal redraws Pi without it.
    const terminal = attach(agent.sessionId, ["dtach", "-a", "/run/pi.dtach", "-r", "winch"]);
    const child = spawn(terminal.file, terminal.args, { stdio: "inherit" });
    child.on("error", (error) => fail(new Error(`cannot start the terminal: ${error.message}`)));
    child.on("exit", () => done());
  });

/** The agent as a Herdr tab in the "bottle" space, named pi-<id> (the Herdr mod looks for that name); it closes when the agent ends. */
const openTab = (config: Config, id: string) =>
  new Promise<void>((done) => {
    if (config.herdr === false) return done();
    const labels = ["--label", "herdr.space=bottle", "--label", `herdr.tab=${id}`];
    const command = [process.execPath, `${import.meta.dirname}/cli.ts`, "attach", id];
    execFile("hc", ["run", "--bg", "--no-parent", "--name", `pi-${id}`, "--cwd", config.outputRoot, ...labels, "--", ...command], (error) => {
      // Without hc on PATH and no "herdr": true, Herdr is simply not in use here.
      if (!error) console.log("It has a tab in Herdr's bottle space.");
      else if (!((error as NodeJS.ErrnoException).code === "ENOENT" && config.herdr === undefined)) console.error(`no Herdr tab: ${error.message}`);
      done();
    });
  });

const isUp = (control: string) =>
  fetch(`${control}/api/state`, { signal: AbortSignal.timeout(2_000) }).then(
    (response) => response.ok,
    () => false,
  );

/** Starts start.sh detached (it outlives this terminal, Herdr panes included) and waits until the control API answers. */
const startBottle = async (control: string) => {
  console.log(`Starting bottle (log ${logFile})`);
  const logStart = existsSync(logFile) ? statSync(logFile).size : 0;
  const out = openSync(logFile, "a", 0o600);
  const child = spawn(join(import.meta.dirname, "..", SCRIPTS.serve), [], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, BOTTLE_AUTOSTART: "1" },
  });
  child.unref();
  closeSync(out);
  let exited: number | null | undefined;
  child.once("exit", (code) => (exited = code));
  for (const deadline = Date.now() + START_WAIT_MS; !(await isUp(control)); await sleep(1_000))
    if (exited !== undefined || Date.now() > deadline) {
      const tail = readFileSync(logFile, "utf8").slice(logStart).trimEnd().split("\n").slice(-20).join("\n");
      throw new Error(`bottle ${exited !== undefined ? `exited (code ${exited})` : "did not answer within a minute"}. From ${logFile}:\n${tail}`);
    }
};

/** Stops the bottle that start.sh recorded; its shutdown archives open agents first. */
const stopBottle = async () => {
  const pid = existsSync(pidFile) ? z.coerce.number().int().positive().safeParse(readFileSync(pidFile, "utf8")).data : undefined;
  const alive = () => {
    try {
      return process.kill(pid!, 0);
    } catch {
      return false;
    }
  };
  if (!pid || !alive()) return void console.log("bottle was not running");
  process.kill(pid, "SIGTERM");
  console.log(`Stopping bottle (pid ${pid}); open agents are archived first`);
  while (alive()) await sleep(500);
  console.log("bottle stopped");
};

const age = (startedAt: string): string => {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
};

/** Untrusted text on one line: control characters (terminal escapes included) and runs of whitespace become one space. */
const clean = (text: string) => text.replace(/[\p{Cc}\s]+/gu, " ").trim();
const truncate = (text: string, width: number) => (clean(text).length > width ? `${clean(text).slice(0, width - 3)}...` : clean(text));
const columns = () => process.stdout.columns ?? 100;
const STATES: Record<string, string> = { "awaiting-grant": "awaiting approval", "failed-archive": "archive failed" };
const stateLabel = (agent: Agent) => (agent.done ? "done" : (STATES[agent.state] ?? agent.state.replaceAll("-", " ")));
const taskLabel = (agent: Agent) => (agent.title ? `${clean(agent.title)} (${clean(agent.name)})` : clean(agent.name));

/** Rows aligned in columns. */
const cells = (rows: string[][]) => {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join("  ")
      .trimEnd(),
  );
};

/** Columns id, task, then more fields. A table when it fits the terminal, otherwise a labelled block per row; ids and URLs are never cut. */
const listing = (header: string[], rows: string[][], extra: string[][]) => {
  if (rows.length === 0) return;
  const lines = cells([header, ...rows]);
  const wide = lines.every((line) => line.length <= columns());
  if (wide) console.log(lines[0]);
  rows.forEach((row, index) => {
    if (wide) console.log(lines[index + 1]);
    else
      console.log(
        `${row[0]}  ${row[1]}\n    ${header
          .slice(2)
          .map((title, at) => `${title[0]}${title.slice(1).toLowerCase()}: ${row[at + 2]}`)
          .join(" · ")}`,
      );
    for (const line of extra[index]!) console.log(`    ${line}`);
  });
};

const loadCliConfig = (): Config => {
  try {
    return loadConfig(configPath);
  } catch (error) {
    throw new Error(`cannot load ${configPath}: ${(error as Error).message.split("\n").join(" ")}`);
  }
};

async function main(command: Command_, values: Values, positionals: string[]) {
  const config = loadCliConfig();
  const control = controlOrigin(config);
  const controlApi = honoClient<ControlApi>(control).api;

  const api = async <R extends { ok: boolean; status: number; json(): Promise<unknown> }>(request: Promise<R>): Promise<Awaited<ReturnType<R["json"]>>> => {
    let response: R;
    try {
      response = await request;
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message;
      throw new Error(`cannot reach bottle at ${control} (${cause}); it is not running. \`${SELF} run\` starts it. Config: ${configPath}`);
    }
    const payload = (await response.json().catch(() => ({}))) as { message?: string; next?: string };
    if (!response.ok) throw new Error([payload.message ?? `HTTP ${response.status} from ${control}`, payload.next].filter(Boolean).join(". "));
    return payload as Awaited<ReturnType<R["json"]>>;
  };

  const agents = async (): Promise<Agent[]> => (await api(controlApi.state.$get())).agents;

  const byId = async (id: string) => (await agents()).find((agent) => agent.id === id);

  /** No id: the only open agent. Otherwise exact id or name first, then unique id or name prefix. */
  const resolveAgent = async (wanted = ""): Promise<Agent> => {
    const all = await agents();
    if (!wanted.trim()) {
      const open = all.filter((agent) => !CLOSED.includes(agent.state));
      if (open.length === 1) return open[0]!;
      throw new Error(
        `${open.length ? `${open.length} agents are open (${open.map((agent) => agent.id).join(", ")}); name one` : "no agent is open"}. See \`${SELF} ls\``,
      );
    }
    const exact = all.filter((agent) => agent.id === wanted || agent.name === wanted);
    const matches = exact.length > 0 ? exact : all.filter((agent) => agent.id.startsWith(wanted) || agent.name.startsWith(wanted));
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error(`no agent matches "${wanted}". See \`${SELF} ls\``);
    throw new Error(`"${wanted}" matches ${matches.length} agents (${matches.map((agent) => agent.id).join(", ")}). Use a longer id`);
  };

  if (command === "down") {
    await stopBottle();
  } else if (command === "templates") {
    const { extensions } = loadCatalog(config);
    const templates = [...loadTemplates(`${config.configRoot}/templates.json`).values()].map((template) => ({
      id: template.id,
      label: template.label,
      ...(template.model && { model: template.model }),
      // What the template gives at launch without a speaker card; the Herdr launch form shows it.
      extensions: givenAtLaunch(template, extensions).map((id) => `ext:${id}`),
    }));
    const models = await Promise.all(
      availableModels(config).map(async ({ id, alias, label }) => {
        const local = id.startsWith("local/");
        return { id, ...(alias && { alias }), label, local, up: local ? await localModelUp(config.localModel.upstream!) : true };
      }),
    );
    if (values.json) return void console.log(JSON.stringify({ templates, models }));
    console.log(cells([["TEMPLATE", "DEFAULT MODEL", "DESCRIPTION"], ...templates.map((entry) => [entry.id, entry.model ?? "-", entry.label])]).join("\n"));
    console.log(
      `\n${cells([["ALIAS", "MODEL", "DESCRIPTION", "AVAILABILITY"], ...models.map((entry) => [entry.alias ?? "-", entry.id, entry.label, entry.local ? (entry.up ? "up" : "down") : "-"])]).join("\n")}`,
    );
  } else if (command === "register") {
    const name = values.name ?? hostname();
    const id = await registerHost(config, configPath, name);
    console.log(`Registered sandbox host "${name}". Approve it at ${config.speaker.url}/admin#host-${id}, then launch an agent with \`${SELF} run\`.`);
  } else if (command === "run") {
    const { template = "builder", name, model, hours } = values;
    const prompt = positionals[0];
    // Attached unless asked otherwise or there is no terminal to attach; an agent nobody watches is unattended.
    const detach = values.detach || !(process.stdin.isTTY && process.stdout.isTTY);
    const attended = values.attended ? true : values.unattended || detach ? false : undefined;
    console.log(`Connecting to bottle at ${control} (speaker ${config.speaker.url})`);
    if (!(await isUp(control))) await startBottle(control);
    // Relative folder paths are this shell's; the service needs absolute ones.
    const folders = values.folder?.map((spec) => (spec.startsWith("~") || spec.startsWith("/") ? spec : resolve(spec)));
    const { id, outputDir } = await api(controlApi.agents.$post({ json: { name, template, model, prompt, attended, hours, folders } }));
    let agent = await byId(id);
    const waiting = agent?.state === "awaiting-grant";
    const request = agent?.pendingRequests[0]?.id;
    console.log(
      `${waiting ? "Waiting for approval" : "Starting"}: ${id} (${agent ? taskLabel(agent) : (name ?? template)}), ${template}, ${clean(agent?.model ?? model ?? "default model")}`,
    );
    if (waiting) console.log(`  Approve: ${config.speaker.url}/admin${request ? `#request-${request}` : ""}`);
    if (detach) console.log(`  Attach:  ${attachCommand(id)}`);
    console.log(`  Archive: ${outputDir}${prompt ? " (when Pi writes /output/DONE)" : ""}`);
    if (detach) return void (await openTab(config, id));
    while (agent?.state === "awaiting-grant") {
      await sleep(2_000);
      agent = await byId(id);
    }
    if (!agent || !ATTACHABLE.includes(agent.state)) throw new Error(`agent ${id} is ${agent?.state ?? "gone"}; see ${SELF} ls`);
    await attachHere(agent);
    const after = await byId(id);
    if (!after || CLOSED.includes(after.state)) return void console.log(`${id} is ${after ? after.state.replaceAll("-", " ") : "gone"}. Archive: ${outputDir}`);
    if (!piRunning(after)) return void console.log(piQuit(id));
    console.log(`Detached; ${id} keeps running. Attach: ${attachCommand(id)}`);
    await openTab(config, id);
  } else if (command === "ls") {
    // The control API's state as it is, for the Herdr mod when bottle is on another machine.
    if (values.json) return void console.log(JSON.stringify(await api(controlApi.state.$get())));
    const up = await isUp(control);
    const list = up ? await agents() : [];
    if (list.length === 0)
      console.log(
        `${up ? `bottle is running at ${control} with no live agents` : `bottle is not running (${control})`}. Start an agent with: ${SELF} run "<prompt>"`,
      );
    const room = Math.max(30, columns() - 14);
    listing(
      ["ID", "TASK", "STATE", "MODEL", "AGE"],
      list.map((agent) => [agent.id, taskLabel(agent), stateLabel(agent), clean(agent.model ?? "-"), agent.startedAt ? age(agent.startedAt) : "-"]),
      list.map((agent) => [
        ...(CLOSED.includes(agent.state) || !agent.summary ? [] : [`Latest: ${truncate(agent.summary, room)}`]),
        ...agent.pendingRequests.flatMap((request) => [
          `Request ${request.id}: ${clean(request.what)} (${truncate(request.reason, room)})`,
          `Approve: ${config.speaker.url}/admin#request-${request.id}`,
        ]),
        ...(agent.attended === undefined ? [] : [`Mode: ${agent.attended ? "attended" : "unattended"}`]),
        ...(agent.launchGrants.length ? [`Launch-held: ${agent.launchGrants.join(", ")}`] : []),
        ...(agent.state === "failed-archive" ? [`Archive failed: the error is recorded in ${config.outputRoot}/*--${agent.id}/_control/agent.json`] : []),
      ]),
    );
    const finished = finishedAgents(config.outputRoot);
    if (finished.length > 0) {
      console.log("\nFinished:");
      listing(
        ["ID", "TASK", "OUTCOME", "ARCHIVE"],
        finished.map(({ id, name, state, outputDir }) => [id, clean(name), state.replaceAll("-", " "), outputDir]),
        finished.map(({ state, outputDir }) =>
          state === "failed-archive" ? [`Archive failed: the error is recorded in ${outputDir}/_control/agent.json; its output is beside it`] : [],
        ),
      );
    }
  } else if (command === "attach") {
    const agent = await resolveAgent(positionals[0]);
    if (!ATTACHABLE.includes(agent.state)) throw new Error(`agent ${agent.id} is ${agent.state}, so it has no terminal to attach to`);
    if ((await api(controlApi.agents[":id"].resume.$post({ param: { id: agent.id } }))).resumed)
      console.log(`Restarted Pi on the same live session of ${agent.id}.`);
    else console.log(`Reconnecting to ${agent.id}: Pi is still running on its live session.`);
    await attachHere(agent);
    console.log(piRunning(agent) ? `Detached; ${agent.id} keeps running.` : piQuit(agent.id));
  } else if (command === "stop") {
    const agent = await resolveAgent(positionals[0]);
    await api(controlApi.agents[":id"].close.$post({ param: { id: agent.id } }));
    console.log(`Closing and archiving ${agent.id} (${clean(agent.name)}) into ${config.outputRoot}. \`${SELF} ls\` shows when it is done.`);
  }
}

const program = new Command(SELF)
  .description("The owner's terminal client for the bottle service.")
  .exitOverride((error) => process.exit(error.exitCode === 1 ? 2 : error.exitCode)); // usage errors exit 2
program
  .command("run")
  .helpGroup("Run/join:")
  .description("Start an agent and attach to its Pi terminal (Ctrl-\\ detaches); with a prompt it runs once and archives when Pi writes /output/DONE")
  .argument("[prompt]", "what the agent should do; none opens Pi for you to type")
  .option("-d, --detach", "do not attach: print the attach command and return (the agent is unattended)")
  .option("-t, --template <name>", "template (see `templates`): sealed, builder, or trusted", "builder")
  .option("-m, --model <id|alias>", "model id or alias; default: the template's model")
  .option(
    "-f, --folder <path[:rw]>",
    "mount a host folder (repeatable): read-only at /input/<name>, with :rw at /space/<name>",
    (spec: string, all: string[] = []) => [...all, spec],
  )
  .option("--name <name>", "agent name")
  .option("--hours <n>", "wall-clock deadline in hours from launch", (text) => {
    const hours = z.coerce.number().positive().safeParse(text);
    if (!hours.success) throw new InvalidArgumentError("a positive number of hours");
    return hours.data;
  })
  .addOption(new Option("--attended", "Pi may ask questions even when detached").conflicts("unattended"))
  .option("--unattended", "Pi records assumptions instead of asking, even when attached")
  .action((prompt: string | undefined, values: Values) => main("run", values, prompt ? [prompt] : []));
program
  .command("templates")
  .helpGroup("Inspect:")
  .description("List the launch templates and the models (with aliases); works without bottle running")
  .option("--json", "print JSON")
  .action((values: Values) => main("templates", values, []));
program
  .command("ls")
  .helpGroup("Inspect:")
  .description("List live agents, and the last finished ones")
  .option("--json", "print JSON")
  .action((values: Values) => main("ls", values, []));
program
  .command("attach")
  .helpGroup("Run/join:")
  .description("Open an agent's Pi terminal; Ctrl-\\ detaches and leaves Pi running")
  .argument("[id|name]", "default: the only open agent")
  .action((agent?: string) => main("attach", {}, agent ? [agent] : []));
program
  .command("stop")
  .helpGroup("Run/join:")
  .description("Close an agent and archive its artifacts and transcript")
  .argument("[id|name]", "default: the only open agent")
  .action((agent?: string) => main("stop", {}, agent ? [agent] : []));
program
  .command("register")
  .helpGroup("Host operations:")
  .description("Register this host as a speaker sandbox host")
  .option("--name <name>", "host name (default: this machine's)")
  .action((values: Values) => main("register", values, []));
program
  .command("serve")
  .helpGroup("Host operations:")
  .description("Run the bottle service in the foreground; Ctrl-C stops it")
  .allowUnknownOption()
  .argument("[args...]")
  .action((args: string[]) => runScript("serve", args));
program
  .command("down")
  .helpGroup("Host operations:")
  .description("Stop bottle; its open agents are archived first")
  .action(() => main("down", {}, []));
program
  .command("build")
  .helpGroup("Host operations:")
  .description("Build the guest image (default tag bottle-guest) and load it into microsandbox")
  .allowUnknownOption()
  .argument("[args...]")
  .action((args: string[]) => runScript("build", args));

try {
  await program.parseAsync();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { attach } from "./sandbox.ts";
import { registerHost } from "./speaker.ts";
import { configPathFromEnv, controlOrigin, loadConfig, type Config } from "./config.ts";

/** The owner's terminal client: `mise run bottle-school:cli register | run | ls | attach | stop`. */
type Task = {
  id: string;
  name: string;
  state: string;
  attended?: boolean;
  model?: string;
  startedAt?: string;
  sessionId: string;
  pendingRequests: { id: string; what: string; reason: string }[];
  done: boolean;
  summary: string;
};

const SELF = "mise run bottle-school:cli";
const FINISHED_SHOWN = 5;
const root = resolve(import.meta.dirname, "../..");
const configPath = configPathFromEnv();
const run = promisify(execFile);

const COMMANDS = {
  register: {
    positional: 0,
    help: `usage: ${SELF} register [--name NAME]

Registers this host as a speaker sandbox host. Writes its token to the config and learns speaker's proxy and SSH
ports. Then approve the sandbox host in speaker /admin and start the service.`,
  },
  run: {
    positional: 0,
    help: `usage: ${SELF} run [--template T] [--name NAME] [--model M] [--prompt TEXT] [--hours H]
                     [--attended | --unattended]

Starts a task. --template defaults to offline, which asks speaker for nothing at launch. With --prompt, the
task runs once and archives when Pi writes /output/DONE. --hours sets a wall-clock deadline, in hours from launch.

An attended task expects you at its terminal, where Pi may ask you questions. An unattended task is told
nobody is watching, so it records assumptions instead of asking. Without --prompt a task is attended; with
--prompt, unattended. A template may fix the mode, and a contradicting flag is refused.`,
  },
  ls: {
    positional: 0,
    help: `usage: ${SELF} ls

Lists live tasks with state, mode (attended or unattended), pending approvals, age, model, name, and Pi's
latest message. Below them it lists the last five finished tasks with their state (archived or failed-archive)
and archive folder.`,
  },
  attach: {
    positional: 1,
    help: `usage: ${SELF} attach <id|name>

Opens Pi's terminal for a task. Ctrl-\\ detaches and leaves Pi running. Ctrl-] leaves the VM shell.`,
  },
  stop: {
    positional: 1,
    help: `usage: ${SELF} stop <id|name>

Closes a task and archives its artifacts and transcript under the configured output root.`,
  },
} as const;
type Command = keyof typeof COMMANDS;

const usage = `usage: ${SELF} <command> [options]

  run        Start a task
  ls         List live tasks
  attach     Open a task's Pi terminal
  stop       Close a task and archive it
  register   Register this host as a speaker sandbox host

Run \`${SELF} help <command>\` or \`${SELF} <command> --help\` for options.`;

/** A mistake in the command line, reported with exit code 2 instead of a runtime failure. */
class UsageError extends Error {}

const parseOptions = (args: string[]) => {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        name: { type: "string" },
        template: { type: "string" },
        model: { type: "string" },
        prompt: { type: "string" },
        hours: { type: "string" },
        attended: { type: "boolean" },
        unattended: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message.split("\n")[0]!);
  }
};

/** The control API and speaker report validation failures as JSON issue arrays; print them on one line. */
const plain = (message: string): string => {
  let issues: unknown;
  try {
    issues = JSON.parse(message);
  } catch {
    return message;
  }
  if (!Array.isArray(issues)) return message;
  return issues.map((issue: { path?: unknown[]; message: string }) => `${issue.path?.join(".") ?? ""} ${issue.message}`.trim()).join("; ");
};

const age = (startedAt: string): string => {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
};

const truncate = (text: string, width: number) => {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > width ? `${oneLine.slice(0, width - 3)}...` : oneLine;
};

/** herdr agent states are idle|working|blocked|unknown; herdr derives its own `done` from idle. */
const report = async (pane: string, task: Task) => {
  const state = task.pendingRequests.length > 0 ? "blocked" : task.state === "busy" ? "working" : "idle";
  const message = task.done ? "done" : task.summary;
  const source = "custom:bottle-school";
  await run("herdr", ["pane", "report-agent", pane, "--source", source, "--agent", "pi", "--state", state, "--message", message]);
  await run("herdr", [
    "pane",
    "report-metadata",
    pane,
    "--source",
    source,
    "--title",
    task.name,
    "--state-label",
    `${state}=${task.pendingRequests.length} pending${task.done ? ", done" : ""}`,
  ]);
};

const loadCliConfig = (): Config => {
  try {
    return loadConfig(configPath);
  } catch (error) {
    throw new Error(`cannot load ${configPath}: ${plain((error as Error).message.split("\n").join(" "))}`);
  }
};

async function main(command: Command, values: ReturnType<typeof parseOptions>["values"], positionals: string[]) {
  const config = loadCliConfig();
  const control = controlOrigin(config);

  const api = async <T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message;
      throw new Error(`cannot reach ${url} (${cause}). Is bottle-school running? Config: ${configPath}`);
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(plain(payload.error ?? `HTTP ${response.status} from ${url}`));
    return payload as T;
  };

  const tasks = async (): Promise<Task[]> => (await api<{ tasks: Task[] }>("GET", `${control}/api/state`)).tasks;

  /** Exact id or name first, then unique id or name prefix. */
  const resolveTask = async (wanted: string): Promise<Task> => {
    if (!wanted.trim()) throw new UsageError(`${command} expects a task id. See \`${SELF} ls\``);
    const all = await tasks();
    const exact = all.filter((task) => task.id === wanted || task.name === wanted);
    const matches = exact.length > 0 ? exact : all.filter((task) => task.id.startsWith(wanted) || task.name.startsWith(wanted));
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error(`no task matches "${wanted}". See \`${SELF} ls\``);
    throw new Error(`"${wanted}" matches ${matches.length} tasks (${matches.map((task) => task.id).join(", ")}). Use a longer id`);
  };

  if (command === "register") {
    const name = values.name ?? "bottle-school";
    const id = await registerHost(config, configPath, name);
    console.log(`Registered sandbox host "${name}". Approve it at ${config.speaker.url}/admin#host-${id}, then start bottle-school.`);
  } else if (command === "run") {
    const { template = "offline", name, model, prompt, hours } = values;
    if (values.attended && values.unattended) throw new UsageError("pass at most one of --attended and --unattended");
    const attended = values.attended ? true : values.unattended ? false : undefined;
    let hoursValue: number | undefined;
    if (hours !== undefined) {
      hoursValue = Number(hours);
      if (!Number.isFinite(hoursValue) || hoursValue <= 0) throw new UsageError(`--hours must be a positive number of hours, got "${hours}"`);
    }
    const { id, outputDir } = await api<{ id: string; outputDir: string }>("POST", `${control}/api/tasks`, {
      name,
      template,
      model,
      prompt,
      attended,
      hours: hoursValue,
    });
    const attach = `cd '${root}' && ${SELF} attach ${id}`;
    if (process.env.HERDR_ENV === "1") {
      const { stdout } = await run("herdr", ["pane", "split", "--current", "--direction", "right", "--env", "HERDR_AGENT=pi"]);
      await run("herdr", ["pane", "run", JSON.parse(stdout).result.pane.pane_id, attach]);
    } else {
      const archive = prompt ? " It archives when Pi writes /output/DONE." : "";
      console.log(
        `Started ${id} (${template}).${archive} Attach: ${attach}\nThe archive will be written to ${outputDir}\nWhen the task asks for access, approve it at ${config.speaker.url}/admin (or check ${SELF} ls).`,
      );
    }
  } else if (command === "ls") {
    const list = await tasks();
    if (list.length === 0) console.log(`No live tasks. Start one with: ${SELF} run --prompt "..."`);
    const header = ["ID", "STATE", "MODE", "PENDING", "AGE", "MODEL", "NAME", "LAST MESSAGE"];
    const rows = list.map((task) => [
      task.id,
      task.done ? "done" : task.state,
      task.attended === undefined ? "-" : task.attended ? "attended" : "unattended",
      String(task.pendingRequests.length),
      task.startedAt ? age(task.startedAt) : "-",
      task.model ?? "-",
      task.name,
      truncate(task.summary ?? "", 60),
    ]);
    if (list.length > 0) {
      const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
      const line = (cells: string[]) =>
        cells
          .map((cell, column) => cell.padEnd(widths[column]!))
          .join("  ")
          .trimEnd();
      console.log(line(header));
      list.forEach((task, index) => {
        console.log(line(rows[index]!));
        for (const request of task.pendingRequests)
          console.log(`    pending approval ${request.id}: ${request.what} (${request.reason}). Approve it at ${config.speaker.url}/admin`);
      });
    }
    // Finished tasks leave the live list; their archive folders name them (<time>--<name>--<id>) and hold the final state.
    const finished = readdirSync(config.outputRoot)
      .sort()
      .reverse()
      .flatMap((folder) => {
        try {
          const { state } = JSON.parse(readFileSync(join(config.outputRoot, folder, "_control", "task.json"), "utf8")) as { state: string };
          return [`${state.padEnd(15)}${join(config.outputRoot, folder)}`];
        } catch {
          return []; // a live task's folder has no task.json yet
        }
      })
      .slice(0, FINISHED_SHOWN);
    if (finished.length > 0) console.log(`\nLast finished tasks (state, archive folder):\n${finished.map((row) => `  ${row}`).join("\n")}`);
  } else if (command === "attach") {
    const task = await resolveTask(positionals[0]!);
    if (["closing", "archived", "failed", "failed-archive"].includes(task.state))
      throw new Error(`task ${task.id} is ${task.state}, so it has no terminal to attach to`);
    console.error(`Attaching to ${task.name} (${task.id}). Ctrl-\\ detaches, and Pi keeps running.`);
    const terminal = attach(task.sessionId, ["dtach", "-a", "/run/pi.dtach"]);
    const child = spawn(terminal.file, terminal.args, { stdio: "inherit" });
    child.on("error", (error) => {
      console.error(`error: cannot start the terminal: ${error.message}`);
      process.exit(1);
    });
    const pane = process.env.HERDR_PANE_ID;
    if (pane) {
      let last = "";
      const poll = async () => {
        try {
          const current = await resolveTask(task.id);
          const key = JSON.stringify([current.state, current.pendingRequests.length, current.done, current.summary]);
          if (key !== last) await report(pane, current);
          last = key;
        } catch {
          // The task may have closed or the service may be briefly unreachable; the terminal stays attached.
        }
      };
      await poll();
      const timer = setInterval(() => void poll(), 2_000);
      child.on("exit", () => clearInterval(timer));
    }
    child.on("exit", (code) => process.exit(code ?? 1));
  } else if (command === "stop") {
    const task = await resolveTask(positionals[0]!);
    await api("POST", `${control}/api/tasks/${task.id}/close`);
    console.log(`Closing ${task.id} (${task.name}). The archive lands in ${config.outputRoot}. Follow progress with ${SELF} ls.`);
  }
}

const [first = "", ...rest] = process.argv.slice(2);
if (first === "" || first === "help" || first === "--help" || first === "-h") {
  const topic = first === "help" ? rest[0] : undefined;
  if (topic !== undefined && Object.hasOwn(COMMANDS, topic)) console.log(COMMANDS[topic as Command].help);
  else if (topic !== undefined) {
    console.error(`error: unknown command "${topic}"\n\n${usage}`);
    process.exitCode = 2;
  } else if (first === "") {
    console.error(usage);
    process.exitCode = 2;
  } else console.log(usage);
} else {
  try {
    if (!Object.hasOwn(COMMANDS, first)) throw new UsageError(`unknown command "${first}"\n\n${usage}`);
    const command = first as Command;
    const { values, positionals } = parseOptions(rest);
    if (values.help) console.log(COMMANDS[command].help);
    else {
      const expected = COMMANDS[command].positional;
      if (positionals.length !== expected)
        throw new UsageError(
          expected === 0
            ? `${command} takes no positional arguments. Pass the prompt with --prompt "..."`
            : `${command} takes exactly one task id, got ${positionals.length}`,
        );
      await main(command, values, positionals);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

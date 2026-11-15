#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { hc as honoClient } from "hono/client";
import { Command, InvalidArgumentError, Option } from "commander";
import { attach } from "./sandbox.ts";
import type { ControlApi } from "./server.ts";
import { registerHost } from "./speaker.ts";
import { configPathFromEnv, controlOrigin, loadConfig, type Config } from "./config.ts";

/** The owner's terminal client: `bottle serve | build | register | run | ls | attach | stop`. */
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
  summary?: string;
};

// mise names the task it runs; installed on PATH, the command is plain `bottle`.
const SELF = process.env.MISE_TASK_NAME === undefined ? "bottle" : "mise run bottle";
const FINISHED_SHOWN = 5;
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

type Values = { name?: string; template?: string; model?: string; prompt?: string; hours?: number; attended?: boolean; unattended?: boolean };
type Command_ = "register" | "run" | "ls" | "attach" | "stop";

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
      throw new Error(`cannot reach ${control} (${cause}). Is bottle running? Config: ${configPath}`);
    }
    const payload = (await response.json().catch(() => ({}))) as { message?: string; next?: string };
    if (!response.ok) throw new Error([payload.message ?? `HTTP ${response.status} from ${control}`, payload.next].filter(Boolean).join(". "));
    return payload as Awaited<ReturnType<R["json"]>>;
  };

  const tasks = async (): Promise<Task[]> => (await api(controlApi.state.$get())).tasks;

  /** Exact id or name first, then unique id or name prefix. */
  const resolveTask = async (wanted: string): Promise<Task> => {
    if (!wanted.trim()) throw new Error(`${command} expects a task id. See \`${SELF} ls\``);
    const all = await tasks();
    const exact = all.filter((task) => task.id === wanted || task.name === wanted);
    const matches = exact.length > 0 ? exact : all.filter((task) => task.id.startsWith(wanted) || task.name.startsWith(wanted));
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error(`no task matches "${wanted}". See \`${SELF} ls\``);
    throw new Error(`"${wanted}" matches ${matches.length} tasks (${matches.map((task) => task.id).join(", ")}). Use a longer id`);
  };

  if (command === "register") {
    const name = values.name ?? hostname();
    const id = await registerHost(config, configPath, name);
    console.log(`Registered sandbox host "${name}". Approve it at ${config.speaker.url}/admin#host-${id}, then start bottle.`);
  } else if (command === "run") {
    const { template = "offline", name, model, prompt, hours } = values;
    const attended = values.attended ? true : values.unattended ? false : undefined;
    const { id, outputDir } = await api(controlApi.tasks.$post({ json: { name, template, model, prompt, attended, hours } }));
    const attach = `cd '${root}' && ${SELF} attach ${id}`;
    const archive = prompt ? " It archives when Pi writes /output/DONE." : "";
    console.log(
      `Started ${id} (${template}).${archive} Attach: ${attach}\nThe archive will be written to ${outputDir}\nWhen the task asks for access, approve it at ${config.speaker.url}/admin (or check ${SELF} ls).`,
    );
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
    if (!["starting", "idle", "busy", "reconfiguring"].includes(task.state))
      throw new Error(`task ${task.id} is ${task.state}, so it has no terminal to attach to`);
    console.error(`Attaching to ${task.name} (${task.id}). Ctrl-\\ detaches, and Pi keeps running.`);
    const terminal = attach(task.sessionId, ["dtach", "-a", "/run/pi.dtach"]);
    const child = spawn(terminal.file, terminal.args, { stdio: "inherit" });
    child.on("error", (error) => {
      console.error(`error: cannot start the terminal: ${error.message}`);
      process.exit(1);
    });
    child.on("exit", (code) => process.exit(code ?? 1));
  } else if (command === "stop") {
    const task = await resolveTask(positionals[0]!);
    await api(controlApi.tasks[":id"].close.$post({ param: { id: task.id } }));
    console.log(`Closing ${task.id} (${task.name}). The archive lands in ${config.outputRoot}. Follow progress with ${SELF} ls.`);
  }
}

const program = new Command(SELF)
  .description("The owner's terminal client for the bottle service.")
  .exitOverride((error) => process.exit(error.exitCode === 1 ? 2 : error.exitCode)); // usage errors exit 2
program
  .command("run")
  .description("Start a task")
  .option("--template <name>", "template; offline asks speaker for nothing at launch", "offline")
  .option("--name <name>", "task name")
  .option("--model <id>", "model")
  .option("--prompt <text>", "run once and archive when Pi writes /output/DONE (implies --unattended)")
  .option("--hours <n>", "wall-clock deadline in hours from launch", (text) => {
    const hours = Number(text);
    if (!Number.isFinite(hours) || hours <= 0) throw new InvalidArgumentError("a positive number of hours");
    return hours;
  })
  .addOption(new Option("--attended", "expect the owner at the task's terminal, where Pi may ask questions").conflicts("unattended"))
  .option("--unattended", "tell Pi nobody is watching, so it records assumptions instead of asking")
  .action((values: Values) => main("run", values, []));
program
  .command("ls")
  .description("List live tasks, and the last finished ones")
  .action(() => main("ls", {}, []));
program
  .command("attach")
  .description("Open a task's Pi terminal; Ctrl-\\ detaches and leaves Pi running")
  .argument("<id|name>")
  .action((task: string) => main("attach", {}, [task]));
program
  .command("stop")
  .description("Close a task and archive its artifacts and transcript")
  .argument("<id|name>")
  .action((task: string) => main("stop", {}, [task]));
program
  .command("register")
  .description("Register this host as a speaker sandbox host")
  .option("--name <name>", "host name (default: this machine's)")
  .action((values: Values) => main("register", values, []));
program
  .command("serve")
  .description("Run the bottle service in the foreground; Ctrl-C stops it")
  .allowUnknownOption()
  .argument("[args...]")
  .action((args: string[]) => runScript("serve", args));
program
  .command("build")
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

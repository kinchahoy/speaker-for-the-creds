#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs, promisify } from "node:util";
import { controlOrigin, loadConfig } from "./config.ts";

/** The owner's terminal client: `bottle register | run | ls | attach | stop`. */
type Task = {
  id: string;
  name: string;
  state: string;
  sessionId: string;
  pendingRequests: { id: string; what: string; reason: string }[];
  done: boolean;
  summary: string;
};

const run = promisify(execFile);
const config = loadConfig(process.env.BOTTLE_CONFIG ?? `${import.meta.dirname}/../config.json`);
const control = controlOrigin(config);
const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    name: { type: "string" },
    template: { type: "string" },
    model: { type: "string" },
    prompt: { type: "string" },
    hours: { type: "string" },
  },
});

const api = async (method: "GET" | "POST", url: string, body?: unknown) => {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${url} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<any>;
};
const tasks = async (): Promise<Task[]> => (await api("GET", `${control}/api/state`)).tasks;
const find = async (wanted = ""): Promise<Task> => {
  const matches = (await tasks()).filter((t) => t.id.startsWith(wanted) || t.name.startsWith(wanted));
  if (!wanted || matches.length !== 1)
    throw new Error(`${matches.length} tasks match "${wanted}"; run \`bottle ls\``);
  return matches[0]!;
};

/** herdr agent states are idle|working|blocked|unknown; herdr derives its own `done` from idle. */
const report = async (pane: string, task: Task) => {
  const state = task.pendingRequests.length > 0 ? "blocked" : task.state === "busy" ? "working" : "idle";
  const message = task.done ? "done" : task.summary;
  const source = "custom:bottle-school";
  await run("herdr", ["pane", "report-agent", pane, "--source", source, "--agent", "pi", "--state", state, "--message", message]);
  await run("herdr", ["pane", "report-metadata", pane, "--source", source, "--title", task.name, "--state-label", `${state}=${task.pendingRequests.length} pending${task.done ? ", done" : ""}`]);
};

if (command === "register") {
  const token = randomBytes(32).toString("hex");
  writeFileSync(`${config.stateRoot}/speaker.token`, token, { mode: 0o600 });
  const name = values.name ?? "bottle-school";
  await api("POST", `${config.speaker.url}/_speaker/enforcers`, {
    name,
    kinds: ["secret", "site", "folder", "mcp"],
    tokenHash: createHash("sha256").update(token).digest("hex"),
  });
  console.log(`Registered enforcer "${name}". Approve it in speaker, then start bottle-school.`);
} else if (command === "run") {
  const { template, name, model, prompt, hours } = values;
  const { id } = await api("POST", `${control}/api/tasks`, {
    name, template, model, prompt, hours: hours === undefined ? undefined : Number(hours),
  });
  const attach = `${process.argv[1]} attach ${id}`;
  if (process.env.HERDR_ENV === "1") {
    const { stdout } = await run("herdr", ["pane", "split", "--current", "--direction", "right", "--env", "HERDR_AGENT=pi"]);
    await run("herdr", ["pane", "run", JSON.parse(stdout).result.pane.pane_id, attach]);
  } else console.log(`Started ${id}. Attach with: ${attach}`);
} else if (command === "ls") {
  for (const t of await tasks())
    console.log(`${t.id}  ${t.state.padEnd(13)} ${String(t.pendingRequests.length).padStart(2)} pending  ${t.name}`);
} else if (command === "attach") {
  const task = await find(positionals[0]);
  const child = spawn(
    `${import.meta.dirname}/../node_modules/.bin/gondolin`,
    ["attach", task.sessionId, "--", "dtach", "-a", "/run/pi.dtach"],
    { stdio: "inherit" },
  );
  const pane = process.env.HERDR_PANE_ID;
  let last = "";
  if (pane) {
    const poll = async () => {
      const current = await find(task.id);
      const key = JSON.stringify([current.state, current.pendingRequests.length, current.done, current.summary]);
      if (key !== last) await report(pane, current);
      last = key;
    };
    await poll();
    const timer = setInterval(() => void poll(), 2_000);
    child.on("exit", () => clearInterval(timer));
  }
  child.on("exit", (code) => process.exit(code ?? 1));
} else if (command === "stop") {
  await api("POST", `${control}/api/tasks/${(await find(positionals[0])).id}/close`);
} else {
  console.error("usage: bottle register | run | ls | attach <id> | stop <id>");
  process.exit(2);
}

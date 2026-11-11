import { gcSessions } from "@earendil-works/gondolin";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { html } from "hono/html";
import { bearerAuth } from "hono/bearer-auth";
import { validator } from "hono/validator";
import { z } from "zod";
import { loadConfig, type Config } from "./config.ts";
import { loadSecrets, secretNames } from "./credentials.ts";
import { loadTemplates } from "./leases.ts";
import { Catalog } from "./pi.ts";
import { readEnforcerToken } from "./speaker.ts";
import { Tasks, type Task } from "./tasks.ts";

type Env = { Variables: { task: Task } };

const NewTask = z
  .object({
    name: z.string().min(1).max(80).optional(),
    template: z.string(),
    model: z.string().optional(),
    /** A one-shot launch: the broker submits this prompt once Pi is ready. */
    prompt: z.string().trim().min(1).max(20_000).optional(),
    /** Whether the owner is at the terminal to answer questions; defaults to attended without a prompt. */
    attended: z.boolean().optional(),
    /** Calendar hours until the broker archives the task; the template's maxRuntimeHours caps it. */
    hours: z.number().positive().optional(),
  })
  .strict();

/** The owner's CLI drives this API. Browsers carry an Origin header, so any request with one is refused. */
export const startControl = (config: Config, tasks: Tasks) => {
  const expectedHost = `${config.bindHost}:${config.controlPort}`;
  const app = new Hono();

  app.use(async (context, next) => {
    if (context.req.header("origin") || context.req.header("host") !== expectedHost)
      return context.json({ error: "this request is not from the bottle CLI" }, 403);
    await next();
  });

  const listTasks = () =>
    Promise.all(
      tasks.list().map(async (task) => ({
        id: task.id,
        name: task.name,
        state: task.state,
        attended: task.attended,
        model: task.model,
        startedAt: task.startedAt,
        sessionId: task.guest.sessionId,
        subjectId: task.subjectId,
        pendingRequests: tasks.pendingRequests(task),
        mcpPending: tasks.mcpPending(task),
        extensionsPending: tasks.extensionsPending(task),
        done: tasks.done(task),
        summary: task.lastMessage,
      })),
    );

  app.get("/api/state", async (context) => context.json({ tasks: await listTasks() }));
  app.get("/", async (context) => {
    const rows = await listTasks();
    return context.html(
      html`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <meta http-equiv="refresh" content="10" />
            <title>bottle-school</title>
            <style>
              body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 960px; }
              table { border-collapse: collapse; width: 100%; }
              th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid #ccc; }
              code { background: #f3f3f3; padding: 0.1rem 0.3rem; }
            </style>
          </head>
          <body>
            <h1>bottle-school</h1>
            <p>
              Read-only status page. Launch a task with
              <code>mise run bottle-cli run --template &lt;id&gt; --prompt "..."</code>.
              Raw state: <a href="/api/state">/api/state</a>
            </p>
            <table>
              <thead>
                <tr><th>id</th><th>name</th><th>state</th><th>mode</th><th>pending requests</th><th>done</th></tr>
              </thead>
              <tbody>
                ${rows.length === 0
                  ? html`<tr><td colspan="6">No tasks.</td></tr>`
                  : rows.map(
                      (row) => html`<tr>
                        <td>${row.id}</td>
                        <td>${row.name}</td>
                        <td>${row.state}</td>
                        <td>${row.attended ? "attended" : "unattended"}</td>
                        <td>${row.pendingRequests}</td>
                        <td>${row.done ? "yes" : "no"}</td>
                      </tr>`,
                    )}
              </tbody>
            </table>
          </body>
        </html>`,
    );
  });
  app.post("/api/tasks", validator("json", (body) => NewTask.parse(body)), async (context) =>
    context.json({ id: (await tasks.create(context.req.valid("json"))).id }),
  );
  app.post("/api/tasks/:id/abort", async (context) =>
    context.json(await tasks.abort(tasks.get(context.req.param("id")))),
  );
  app.post("/api/tasks/:id/restart", async (context) => {
    const task = tasks.get(context.req.param("id"));
    await tasks.restart(task);
    return context.json({ state: task.state });
  });
  app.post("/api/tasks/:id/close", (context) => {
    void tasks.close(tasks.get(context.req.param("id")));
    return context.json({ closing: context.req.param("id") }, 202);
  });

  app.onError((error, context) => context.json({ error: error.message }, 400));
  serve({ fetch: app.fetch, hostname: config.bindHost, port: config.controlPort });
  console.log(`control  http://${expectedHost}`);
};

/** The mapped guest endpoint only accepts a task token and only reports status. */
export const startGuestListener = (config: Config, tasks: Tasks) => {
  const app = new Hono<Env>();

  app.use(
    bearerAuth<Env>({
      verifyToken: (token, context) => {
        const task = tasks.byToken.get(token);
        if (task) context.set("task", task);
        return task !== undefined;
      },
    }),
  );

  app.post(
    "/guest/status",
    validator("json", (body) =>
      z
        .object({ busy: z.boolean(), summary: z.string().max(400).optional() })
        .strict()
        .parse(body),
    ),
    (context) => {
      const task = context.get("task");
      const { busy, summary } = context.req.valid("json");
      if (task.state === "idle" || task.state === "busy") task.state = busy ? "busy" : "idle";
      if (summary) {
        task.lastMessage = summary;
        task.lastMessageAt = new Date().toISOString();
      }
      return context.json({ state: task.state });
    },
  );

  app.onError((error, context) => context.json({ error: error.message }, 400));
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.guestPort });
  console.log(`guest    127.0.0.1:${config.guestPort}`);
};

/** Starts the trusted service: catalog, host secrets, launch templates, task manager, and both listeners. */
export const startBroker = (config: Config) => {
  if ("archive" in config.shareRoots) throw new Error("archive is a reserved share root name");
  // A closed task's artifacts can become a read-only input of the next task.
  config.shareRoots.archive = config.outputRoot;

  const readJson = (path: string): unknown =>
    JSON.parse(readFileSync(`${config.configRoot}/${path}`, "utf8"));
  const catalog = Catalog.parse(readJson("catalog.json"));
  const secrets = loadSecrets(`${config.configRoot}/secrets.env`);
  const templates = loadTemplates(`${config.configRoot}/templates.json`);
  const tasks = new Tasks(config, templates, catalog, secrets, readEnforcerToken(config));
  startControl(config, tasks);
  startGuestListener(config, tasks);
  console.log(`templates ${[...templates.keys()].join(" ")}`);
  console.log(`secrets  ${secretNames(secrets).join(" ") || "none"}`);
  return { tasks };
};

if (import.meta.main) {
  const configPath = process.env.PI_V2_CONFIG ?? `${import.meta.dirname}/../config.json`;
  const config = loadConfig(configPath);
  const staleSessions = await gcSessions();
  if (staleSessions) console.log(`reconciled ${staleSessions} stale Gondolin session records`);
  const { tasks } = startBroker(config);

  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const task of tasks.list())
        await tasks
          .close(task)
          .catch((error: Error) => console.error(`archive of ${task.id} failed: ${error.message}`));
      process.exit(process.exitCode ?? 0);
    });
}

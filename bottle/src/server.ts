import { serve } from "@hono/node-server";
import { Hono, type ErrorHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { z } from "zod";
import { reconcile } from "./sandbox.ts";
import { configPathFromEnv, loadConfig, type Config } from "./config.ts";
import { errorBody } from "../../speaker/items.ts";
import { codes, loadTemplates, StatusError } from "./grants.ts";
import { loadCatalog } from "./pi.ts";
import { readHostToken } from "./speaker.ts";
import { closed, Tasks, type Task } from "./tasks.ts";

type Env = { Variables: { task: Task } };

const NewTask = z
  .object({
    name: z.string().min(1).max(80).optional(),
    template: z.string(),
    model: z.string().optional(),
    /** A one-shot launch: the service submits this prompt once Pi is ready. */
    prompt: z.string().trim().min(1).max(20_000).optional(),
    /** Whether the owner is at the terminal to answer questions; defaults to attended without a prompt. */
    attended: z.boolean().optional(),
    /** Calendar hours until the service archives the task; the template's maxRuntimeHours caps it. */
    hours: z.number().positive().optional(),
  })
  .strict();

/** Every error answers speaker's shape, `{ error, message, next? }`: a StatusError or Hono's own HTTPException (a bad token, malformed JSON) carries its status, bad input is 400, anything else 500. */
export const failure: ErrorHandler = (error, context) => {
  const status = (
    error instanceof StatusError || error instanceof HTTPException ? error.status : error instanceof z.ZodError ? 400 : 500
  ) as keyof typeof codes;
  const message = error instanceof z.ZodError ? z.prettifyError(error) : error.message;
  const next = error instanceof StatusError ? error.next : undefined;
  return context.json(errorBody(codes[status], message, next === undefined ? {} : { next }), status);
};

/** The owner's CLI drives this API. Browsers carry an Origin header, so any request with one is refused. */
export const startControl = (config: Config, tasks: Tasks) => {
  const expectedHost = `${config.bindHost}:${config.controlPort}`;
  const app = new Hono();

  app.use(async (context, next) => {
    if (context.req.header("origin") || context.req.header("host") !== expectedHost)
      return context.json(errorBody("denied", "this request is not from the bottle CLI", { next: "use the bottle CLI: bottle help" }), 403);
    await next();
  });

  const listTasks = () =>
    tasks.list().map((task) => ({
      id: task.id,
      name: task.name,
      state: task.state,
      attended: task.attended,
      model: task.model,
      startedAt: task.startedAt,
      sessionId: task.guest.sessionId,
      agentId: task.agentId,
      pendingRequests: tasks.pendingRequests(task),
      done: tasks.done(task),
      summary: task.lastMessage,
    }));

  const routes = app
    .get("/api/state", (context) => context.json({ tasks: listTasks() }))
    .post(
      "/api/tasks",
      validator("json", (body) => NewTask.parse(body)),
      async (context) => context.json(await tasks.create(context.req.valid("json")).then(({ id, outputDir }) => ({ id, outputDir }))),
    )
    .post("/api/tasks/:id/close", (context) => {
      const task = tasks.get(context.req.param("id"));
      if (closed(task)) throw new StatusError(409, `task ${task.id} is already ${task.state}`);
      tasks.close(task).catch((error: Error) => console.error(`archive of ${task.id} failed: ${error.message}`)); // the state records it
      return context.json({ closing: task.id }, 202);
    })
    .onError(failure);
  serve({ fetch: app.fetch, hostname: config.bindHost, port: config.controlPort });
  console.log(`control  http://${expectedHost}`);
  return routes;
};
export type ControlApi = ReturnType<typeof startControl>;

/** The mapped guest endpoint only accepts a task token and only reports status. */
export const startGuestListener = (config: Config, tasks: Tasks) => {
  const app = new Hono<Env>();

  app.use(
    bearerAuth<Env>({
      verifyToken: (token, context) => {
        const task = tasks.byGuestToken.get(token);
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
      tasks.report(task, busy);
      if (summary) task.lastMessage = summary;
      return context.json({ state: task.state });
    },
  );

  app.onError(failure);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.guestPort });
  console.log(`guest    127.0.0.1:${config.guestPort}`);
  return server;
};

/** Starts the trusted service: catalog, launch templates, task manager, and both listeners. */
export const startService = (config: Config) => {
  const catalog = loadCatalog(config);
  const templates = loadTemplates(`${config.configRoot}/templates.json`);
  const tasks = new Tasks(config, templates, catalog, readHostToken(config));
  startControl(config, tasks);
  startGuestListener(config, tasks);
  console.log(`templates ${[...templates.keys()].join(" ")}`);
  return { tasks };
};

if (import.meta.main) {
  const configPath = configPathFromEnv();
  const config = loadConfig(configPath);
  const staleSessions = await reconcile();
  if (staleSessions) console.log(`removed ${staleSessions} microsandbox VMs a crashed service left behind`);
  const { tasks } = startService(config);

  process.on("SIGHUP", () => {
    try {
      tasks.reloadCatalog(loadCatalog(config));
      console.log("catalog reloaded");
    } catch (error) {
      console.error(`catalog not reloaded, the previous one stays: ${(error as Error).message}`);
    }
  });

  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const task of tasks.list()) await tasks.close(task).catch((error: Error) => console.error(`archive of ${task.id} failed: ${error.message}`));
      process.exit(process.exitCode ?? 0);
    });
}

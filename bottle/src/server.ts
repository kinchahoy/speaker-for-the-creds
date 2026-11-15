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
import { closed, Agents, type Agent } from "./agents.ts";

type Env = { Variables: { agent: Agent } };

const NewAgent = z
  .object({
    name: z.string().min(1).max(80).optional(),
    template: z.string(),
    model: z.string().optional(),
    /** A one-shot launch: the service submits this prompt once Pi is ready. */
    prompt: z.string().trim().min(1).max(20_000).optional(),
    /** Whether the owner is at the terminal to answer questions; defaults to attended without a prompt. */
    attended: z.boolean().optional(),
    /** Calendar hours until the service archives the agent; the template's maxRuntimeHours caps it. */
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
export const startControl = (config: Config, agents: Agents) => {
  const expectedHost = `${config.bindHost}:${config.controlPort}`;
  const app = new Hono();

  app.use(async (context, next) => {
    if (context.req.header("origin") || context.req.header("host") !== expectedHost)
      return context.json(errorBody("denied", "this request is not from the bottle CLI", { next: "use the bottle CLI: bottle help" }), 403);
    await next();
  });

  const listAgents = () =>
    agents.list().map((agent) => ({
      id: agent.id,
      name: agent.name,
      state: agent.state,
      attended: agent.attended,
      model: agent.model,
      startedAt: agent.startedAt,
      sessionId: agent.guest.sessionId,
      speakerAgentId: agent.speakerAgentId,
      pendingRequests: agents.pendingRequests(agent),
      done: agents.done(agent),
      summary: agent.lastMessage,
    }));

  const routes = app
    .get("/api/state", (context) => context.json({ agents: listAgents() }))
    .post(
      "/api/agents",
      validator("json", (body) => NewAgent.parse(body)),
      async (context) => context.json(await agents.create(context.req.valid("json")).then(({ id, outputDir }) => ({ id, outputDir }))),
    )
    .post("/api/agents/:id/close", (context) => {
      const agent = agents.get(context.req.param("id"));
      if (closed(agent)) throw new StatusError(409, `agent ${agent.id} is already ${agent.state}`);
      agents.close(agent).catch((error: Error) => console.error(`archive of ${agent.id} failed: ${error.message}`)); // the state records it
      return context.json({ closing: agent.id }, 202);
    })
    .onError(failure);
  serve({ fetch: app.fetch, hostname: config.bindHost, port: config.controlPort });
  console.log(`control  http://${expectedHost}`);
  return routes;
};
export type ControlApi = ReturnType<typeof startControl>;

/** The mapped guest endpoint only accepts an agent token and only reports status. */
export const startGuestListener = (config: Config, agents: Agents) => {
  const app = new Hono<Env>();

  app.use(
    bearerAuth<Env>({
      verifyToken: (token, context) => {
        const agent = agents.byGuestToken.get(token);
        if (agent) context.set("agent", agent);
        return agent !== undefined;
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
      const agent = context.get("agent");
      const { busy, summary } = context.req.valid("json");
      agents.report(agent, busy);
      if (summary) agent.lastMessage = summary;
      return context.json({ state: agent.state });
    },
  );

  app.onError(failure);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.guestPort });
  console.log(`guest    127.0.0.1:${config.guestPort}`);
  return server;
};

/** Starts the trusted service: catalog, launch templates, agent manager, and both listeners. */
export const startService = (config: Config) => {
  const catalog = loadCatalog(config);
  const templates = loadTemplates(`${config.configRoot}/templates.json`);
  const agents = new Agents(config, templates, catalog, readHostToken(config));
  startControl(config, agents);
  startGuestListener(config, agents);
  console.log(`templates ${[...templates.keys()].join(" ")}`);
  return { agents };
};

if (import.meta.main) {
  const configPath = configPathFromEnv();
  const config = loadConfig(configPath);
  const staleSessions = await reconcile();
  if (staleSessions) console.log(`removed ${staleSessions} microsandbox VMs a crashed service left behind`);
  const { agents } = startService(config);

  process.on("SIGHUP", () => {
    try {
      agents.reloadCatalog(loadCatalog(config));
      console.log("catalog reloaded");
    } catch (error) {
      console.error(`catalog not reloaded, the previous one stays: ${(error as Error).message}`);
    }
  });

  // Started on demand by `bottle run` (BOTTLE_AUTOSTART): stop through the normal shutdown once idle long enough.
  if (process.env.BOTTLE_AUTOSTART) {
    let idleSince = Date.now();
    setInterval(() => {
      if (agents.list().some((agent) => !closed(agent))) idleSince = Date.now();
      else if (Date.now() - idleSince >= config.idleStopMinutes * 60_000) {
        console.log(`no open agents for ${config.idleStopMinutes} minutes; stopping`);
        process.kill(process.pid, "SIGTERM");
      }
    }, 30_000).unref();
  }

  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const agent of agents.list()) await agents.close(agent).catch((error: Error) => console.error(`archive of ${agent.id} failed: ${error.message}`));
      process.exit(process.exitCode ?? 0);
    });
}

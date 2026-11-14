// Speaker's HTTP server: the agent and sandbox-host API with the service proxy (api.ts), the owner's admin pages
// (admin.ts), and the secrets proxy (proxy.ts), all over the in-memory state in core.ts.
import { once } from 'node:events'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { adminApp } from './admin.ts'
import { agentApi } from './api.ts'
import { agentError, createCore, type Env, readConfig } from './core.ts'
import { IllegalTransition } from './lifecycle.ts'

export { readConfig }
export const wss = new WebSocketServer({ noServer: true })

export async function createApp(config: ReturnType<typeof readConfig>) {
  const core = await createCore(config)
  const app = new Hono<Env>()
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      // Agent routes answer in JSON; admin pages keep their plain-text messages.
      if (error.res || c.req.path.startsWith('/admin')) return error.getResponse()
      return agentError(c, error.status, 'invalid', error.message)
    }
    if (error instanceof IllegalTransition) return agentError(c, 409, 'conflict', error.message)
    // A malformed body from an authenticated agent counts as refused on the owner's page.
    const caller = c.get('caller')
    if ((error instanceof z.ZodError || error instanceof SyntaxError) && caller?.role === 'agent')
      core.tally(
        caller.agent,
        'refused',
        error instanceof z.ZodError ? z.prettifyError(error).replaceAll('\n', ' ') : 'Body is not valid JSON',
      )
    if (error instanceof z.ZodError)
      return agentError(c, 400, 'invalid', 'The request body is invalid', {
        next: 'Fix the listed fields and repeat the call',
        fields: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          ...('values' in issue ? { accepted: issue.values } : {}),
        })),
      })
    if (error instanceof SyntaxError)
      return agentError(c, 400, 'invalid', 'Body is not valid JSON', { next: 'Send a JSON body' })
    core.audit('request_failed', { type: error.name, message: error.message })
    return agentError(c, 500, 'internal_error', 'Speaker failed on this call', {
      tell_user: 'Speaker hit an internal error; the owner can find the cause in its log',
    })
  })
  // Clock-driven transitions apply before every request.
  app.use('*', async (_c, next) => {
    core.sweep()
    await next()
  })
  agentApi(app, core, adminApp(core))
  if (core.proxy) {
    core.proxy.listen(config.PROXY_PORT, '0.0.0.0')
    await once(core.proxy, 'listening')
  }
  return Object.assign(app, { proxy: core.proxy, stop: () => core.jump.stop() })
}

if (import.meta.main) {
  const config = (() => {
    try {
      return readConfig()
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error
      console.error(`speaker: fix the environment and restart:\n${z.prettifyError(error)}`)
      process.exit(1)
    }
  })()
  const app = await createApp(config)
  // Stop the jump server and ssh-agent with speaker: left running, they keep SSH_PORT and block the next start.
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => void app.stop().finally(() => process.exit(0)))
  serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0', websocket: { server: wss } }, (info) =>
    console.log(JSON.stringify({ time: new Date().toISOString(), event: 'listening', port: info.port })),
  )
}

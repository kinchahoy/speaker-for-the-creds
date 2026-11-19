// Logged-in browser sites (`browser:<site>`). The owner opens a site's headless Chromium from Setup and signs in by hand
// in the live view; agents holding a grant send allowlisted commands (POST /_speaker/browser/<site>, in api.ts). Chromium
// runs as another OS user behind browser-broker.ts: this module only calls the broker and relays the live view. Nothing
// persists: a session ends when the owner closes it, its lifetime runs out, its setup changes, or speaker stops.
import { upgradeWebSocket } from '@hono/node-server'
import type { Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import WebSocket from 'ws'
import { z } from 'zod'
import { coversAny } from './items.ts'
import { type BrowserState, browserTable, transition } from './lifecycle.ts'

export type BrowserSite = { startUrl: string; domains: string[] }
type Env = {
  broker?: { url: string; token: string }
  publicOrigin: string
  sites: () => Record<string, BrowserSite>
  audit: (event: string, fields?: Record<string, unknown>) => void
}
type Session = { state: BrowserState; until: number; port?: number; setup: string }

export const brokerMissing =
  'Browser sites are not set up: set BROWSER_BROKER_URL and BROWSER_BROKER_TOKEN and start browser-broker.ts as the browser user'
export const lifetimes = { '1h': 3600_000, '8h': 28_800_000, '1d': 86_400_000 }
// What an agent may send: the command, then its arguments. No argument may look like a flag (agent-browser reads flags
// anywhere, so `--session` or `--profile` would escape the site), except snapshot's own -i and -c.
export const browserUsage = [
  'open <url>',
  'snapshot [-i] [-c]',
  'click <ref>',
  'fill <ref> <text>',
  'type <ref> <text>',
  'press <key>',
  'scroll <up|down|left|right> [px]',
  'wait <ref|ms>',
  'back',
  'forward',
  'reload',
  'screenshot',
  'get url|title|text [ref]',
]
export const browserCommandSchema = z.object({ args: z.array(z.string().max(10_000)).min(1).max(10) })
const brokerReply = z.object({
  ok: z.boolean(),
  data: z.record(z.string(), z.unknown()).nullable(),
  error: z.unknown(),
  png: z.string().optional(),
})
// The live view's input: only mouse and keyboard events reach Chromium; anything else the page sends is dropped.
const inputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('input_mouse'),
    eventType: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']),
    x: z.number(),
    y: z.number(),
    button: z.enum(['none', 'left', 'middle', 'right']).optional(),
    clickCount: z.number().int().min(0).max(3).optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
  }),
  z.object({
    type: z.literal('input_keyboard'),
    eventType: z.enum(['keyDown', 'keyUp', 'char']),
    key: z.string().max(20).optional(),
    code: z.string().max(20).optional(),
    text: z.string().max(4).optional(),
    windowsVirtualKeyCode: z.number().int().min(0).max(255).optional(),
  }),
])

// The live view page's messages: anything that is not JSON is dropped like any other unknown input.
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function createBrowser(env: Env) {
  const sessions = new Map<string, Session>()
  const live = (site: string) => sessions.get(site)?.state === 'live'
  async function run(args: string[], screenshot = false) {
    if (!env.broker) throw new HTTPException(503, { message: brokerMissing })
    const response = await fetch(`${env.broker.url.replace(/\/$/, '')}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.broker.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ args, screenshot }),
    })
    if (!response.ok) throw new Error(`browser broker answered ${response.status}: ${await response.text()}`)
    return brokerReply.parse(await response.json())
  }
  // Why the command cannot run on this site, or undefined when it may.
  function check(site: string, args: string[]) {
    const [command, ...rest] = args
    const flag = rest.find((arg) => arg.startsWith('-') && !(command === 'snapshot' && ['-i', '-c'].includes(arg)))
    if (![...browserUsage.map((usage) => usage.split(' ')[0]), 'goto'].includes(command))
      return `${command} is not a browser command you can send`
    if (flag) return `${flag} is not allowed: no argument may start with -`
    if (command === 'screenshot' && rest.length) return 'screenshot takes no arguments'
    if (command === 'get' && !['url', 'title', 'text'].includes(rest[0])) return 'get takes url, title or text'
    if (command === 'open' || command === 'goto') {
      const url = URL.canParse(rest[0]) ? new URL(rest[0]) : undefined
      const domains = env.sites()[site].domains
      if (rest.length !== 1 || !url || !['http:', 'https:'].includes(url.protocol) || !coversAny(domains, url.hostname))
        return `${command} takes one http(s) URL on ${domains.join(', ')}`
    }
    return undefined
  }
  async function open(site: string, life: number) {
    const setup = Object.hasOwn(env.sites(), site) ? env.sites()[site] : undefined
    if (!setup) throw new HTTPException(404, { message: `There is no browser site ${site}` })
    transition('browser', browserTable, sessions.get(site)?.state ?? 'off', 'open')
    // A session left by an earlier speaker would keep its old domains and login: start from nothing.
    await run(['--session', site, 'close'])
    const opened = await run([
      '--session',
      site,
      '--idle-timeout',
      '0',
      '--allowed-domains',
      setup.domains.join(','),
      'open',
      setup.startUrl,
    ])
    if (!opened.ok) throw new HTTPException(502, { message: `Could not open ${site}: ${String(opened.error)}` })
    const session: Session = { state: 'live', until: Date.now() + life, setup: JSON.stringify(setup) }
    sessions.set(site, session)
    env.audit('browser_opened', { site, until: new Date(session.until).toISOString() })
    const status = await run(['--session', site, 'stream', 'status'])
    session.port = z.number().int().parse(status.data?.port)
  }
  // The state changes at once (so the sweep never closes one twice); the broker call follows.
  async function close(site: string, why: string) {
    const session = sessions.get(site)
    transition('browser', browserTable, session?.state ?? 'off', 'close')
    sessions.delete(site)
    env.audit('browser_closed', { site, why })
    await run(['--session', site, 'close'])
  }
  const closeQuietly = (site: string, why: string) =>
    close(site, why).catch((error) => env.audit('browser_close_failed', { site, why: String(error) }))
  // Clock and setup: a session past its lifetime, or whose site was changed or removed, closes.
  function sweep() {
    for (const [site, session] of sessions)
      if (session.until <= Date.now()) void closeQuietly(site, 'expired')
      else if (JSON.stringify(env.sites()[site]) !== session.setup) void closeQuietly(site, 'setup changed')
  }

  function routes(admin: Hono, fields: (c: Context) => Promise<Record<string, unknown>>) {
    const back = '/admin?section=services#setup-browsers'
    admin.post('/browser/:site/open', async (c) => {
      const { life } = z.object({ life: z.enum(['1h', '8h', '1d']) }).parse(await fields(c))
      await open(c.req.param('site'), lifetimes[life])
      return c.redirect(`/admin/browser/${encodeURIComponent(c.req.param('site'))}`, 303)
    })
    admin.post('/browser/:site/close', async (c) => {
      await close(c.req.param('site'), 'closed by the owner')
      return c.redirect(back, 303)
    })
    // The live view. A WebSocket upgrade is a GET, so the admin same-origin check does not cover it: check Origin here.
    // The owner's cookie is checked by the sign-in gate in front of every admin route.
    admin.get(
      '/browser/:site/ws',
      async (c, next) => {
        if (c.req.header('origin') !== env.publicOrigin) return c.text('Cross-origin live view refused', 403)
        if (!sessions.get(c.req.param('site'))?.port) return c.text('This site is not open', 409)
        await next()
      },
      upgradeWebSocket((c) => {
        const site = c.req.param('site') ?? ''
        let upstream: WebSocket | undefined
        return {
          onOpen(_event, ws) {
            upstream = new WebSocket(`ws://127.0.0.1:${sessions.get(site)?.port}/?maxFps=10`)
            // Frames go to the page as binary JPEG.
            upstream.on('message', (data) => {
              const message = JSON.parse(String(data)) as { type?: string; data?: string }
              if (message.type === 'frame' && message.data) ws.send(Buffer.from(message.data, 'base64'))
            })
            upstream.on('close', () => ws.close())
            upstream.on('error', () => ws.close(1011, 'browser stream failed'))
          },
          onMessage(event) {
            const input = inputSchema.safeParse(parseJson(String(event.data)))
            if (input.success && upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(input.data))
          },
          onClose: () => upstream?.close(),
        }
      }),
    )
  }

  return {
    ready: env.broker !== undefined,
    live,
    until: (site: string) => sessions.get(site)?.until,
    check,
    run,
    open,
    close,
    sweep,
    routes,
    async stop() {
      await Promise.allSettled([...sessions.keys()].map((site) => close(site, 'speaker stopped')))
    },
  }
}

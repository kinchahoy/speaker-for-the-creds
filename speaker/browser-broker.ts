// The browser broker: runs agent-browser (and so Chromium) as its own OS user, so speaker's process never shares a
// user with the logged-in browser. One route, POST /run {args}, behind a bearer token; speaker makes every check
// (grants, commands, domains) before it calls here. Started as `node browser-broker.ts` by the browser user.
import { execFile } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { json } from 'node:stream/consumers'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const parsed = z
  .object({
    BROWSER_BROKER_PORT: z.coerce.number().int().min(1).max(65535),
    BROWSER_BROKER_TOKEN: z.string().min(32, 'Use a random token of at least 32 characters'),
    AGENT_BROWSER_EXECUTABLE_PATH: z.string().min(1, 'Point it at a Chromium binary'),
  })
  .safeParse(process.env)
if (!parsed.success) {
  console.error(`browser-broker: fix the environment and restart:\n${z.prettifyError(parsed.error)}`)
  process.exit(1)
}
const { BROWSER_BROKER_PORT: port, BROWSER_BROKER_TOKEN: token } = parsed.data
// Private to this user (mode 700): the action policy, screenshots, and agent-browser's HOME (its sockets and state),
// so nothing outlives the broker.
const dir = mkdtempSync(join(tmpdir(), 'browser-broker-'))
process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => process.exit(0))
// Default deny, keyed on agent-browser's action names: no eval, cookies, storage, state, network routes or uploads.
const policy = join(dir, 'policy.json')
writeFileSync(
  policy,
  JSON.stringify({
    default: 'deny',
    allow: [
      'navigate',
      'snapshot',
      'click',
      'fill',
      'type',
      'press',
      'scroll',
      'screenshot',
      'url',
      'title',
      'gettext',
      'wait',
      'back',
      'forward',
      'reload',
      'keyboard',
      'mousemove',
      'tab_list',
      'stream_status',
      'close',
    ],
  }),
)
const bin = fileURLToPath(new URL('./node_modules/.bin/agent-browser', import.meta.url))
const digest = (value: string) => createHash('sha256').update(value).digest()
const bodySchema = z.object({ args: z.array(z.string()).min(1), screenshot: z.boolean().default(false) })
const replySchema = z.object({
  success: z.boolean(),
  data: z.record(z.string(), z.unknown()).nullish(),
  error: z.unknown(),
})

createServer(async (req, res) => {
  const answer = (status: number, body: object) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  if (req.method !== 'POST' || req.url !== '/run') return answer(404, { error: 'POST /run only' })
  if (!timingSafeEqual(digest(req.headers.authorization ?? ''), digest(`Bearer ${token}`)))
    return answer(401, { error: 'wrong token' })
  const body = bodySchema.safeParse(await json(req).catch(() => null))
  if (!body.success) return answer(400, { error: z.prettifyError(body.error) })
  // A screenshot goes to a path the broker picks; speaker says so with `screenshot: true` and sends no path.
  const shot = body.data.screenshot ? join(dir, `${Date.now()}-${Math.random()}.png`) : undefined
  const args = ['--json', '--action-policy', policy, ...body.data.args, ...(shot ? [shot] : [])]
  const env = { ...process.env, HOME: dir, AGENT_BROWSER_NO_VERSION_CHECK: '1' }
  // agent-browser exits 1 on a failed command and still prints its JSON answer.
  execFile(bin, args, { cwd: dir, env, timeout: 30_000 }, (error, stdout) => {
    try {
      const reply = replySchema.parse(JSON.parse(stdout))
      const png = shot && reply.data?.path === shot ? readFileSync(shot).toString('base64') : undefined
      answer(200, { ok: reply.success, data: reply.data ?? null, error: reply.error ?? null, ...(png ? { png } : {}) })
    } catch {
      answer(200, { ok: false, data: null, error: error?.message ?? 'agent-browser printed no answer' })
    } finally {
      if (shot) rmSync(shot, { force: true })
    }
  })
}).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'browser_broker_listening', port })))

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { serve } from '@hono/node-server'
import WebSocket, { WebSocketServer } from 'ws'
import { createApp, readConfig } from '../server.ts'

const upstreamSecret = 'secret-only-the-upstream-should-see'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const ownerHeaders = {
  authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}`,
  origin: 'http://localhost',
  'content-type': 'application/json',
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
type Lease = { id: string; kind: string; ref: string; expiresAt: string | null; state: string }
type Snapshot = {
  type: string
  leases: Lease[]
  requests: { id: string; status: string; what: string; reason: string }[]
}
const port = (server: { address(): string | AddressInfo | null }) => (server.address() as AddressInfo).port

async function setup(t: TestContext, bundles: object = {}) {
  const calls: { url?: string; headers: IncomingHttpHeaders }[] = []
  const upstream = createServer((req, res) => {
    calls.push({ url: req.url, headers: req.headers })
    if (req.url?.startsWith('/base/redirect')) return void res.writeHead(302, { location: '/must-not-follow' }).end()
    res.setHeader('content-type', 'application/json').end('{"ok":true}')
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const dataDir = await mkdtemp(join(tmpdir(), 'speaker-test-'))
  await writeFile(join(dataDir, 'bundles.json'), JSON.stringify(bundles))
  const app = await createApp(readConfig({ ADMIN_PASSWORD: 'pw', DATA_DIR: dataDir, PUBLIC_URL: 'http://localhost' }))
  const server = serve({
    fetch: app.fetch,
    port: 0,
    hostname: '127.0.0.1',
    websocket: { server: new WebSocketServer({ noServer: true }) },
  }) as Server
  await once(server, 'listening')
  const url = `http://127.0.0.1:${port(server)}`
  t.after(async () => {
    server.closeAllConnections()
    upstream.closeAllConnections()
    server.close()
    upstream.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const call = (path: string, init: RequestInit = {}) => fetch(url + path, { redirect: 'manual', ...init })
  const owner = (path: string, body: object = {}) =>
    call(`/admin${path}`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify(body) })
  const ownerForm = (path: string, body: Record<string, string>) =>
    call(`/admin${path}`, {
      method: 'POST',
      headers: { authorization: ownerHeaders.authorization, origin: ownerHeaders.origin },
      body: new URLSearchParams(body),
    })
  const leases = async () => (await call('/admin/api/leases', { headers: ownerHeaders })).json() as Promise<Lease[]>
  const saved = await ownerForm('/providers/save', {
    id: 'notes',
    baseUrl: `http://127.0.0.1:${port(upstream)}/base`,
    authType: 'bearer',
    secret: upstreamSecret,
    read: 'approval',
    write: 'approval',
  })
  assert.equal(saved.status, 303)
  return { url, call, owner, ownerForm, leases, calls }
}
type Fixture = Awaited<ReturnType<typeof setup>>

async function approvedEnforcer(f: Fixture) {
  const tokenHash = sha('enforcer-token')
  const created = await f.call('/_speaker/enforcers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test', kinds: ['site'], tokenHash }),
  })
  const { id } = (await created.json()) as { id: string }
  assert.equal((await f.ownerForm(`/enforcers/${id}/approve`, {})).status, 303)
  const subject = await f.call('/_speaker/subjects', {
    method: 'POST',
    headers: bearer('enforcer-token'),
    body: JSON.stringify({ label: 'pi' }),
  })
  return { id, subject: (await subject.json()) as { id: string; token: string } }
}

const requestSite = (f: Fixture, token: string, body: object) =>
  f.call('/_speaker/requests', { method: 'POST', headers: bearer(token), body: JSON.stringify(body) })

test('session enroll, approval, request approval, then the proxy injects the credential', async (t) => {
  const f = await setup(t)
  const enrolled = await f.call('/_speaker/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'big agent', tokenHash: sha('session-token'), duration: '1h' }),
  })
  const { id } = (await enrolled.json()) as { id: string }
  const call = () => f.call('/notes/things?q=1', { headers: bearer('session-token') })
  assert.equal((await call()).status, 401)
  assert.equal((await f.ownerForm(`/sessions/${id}/approve`, { duration: '1h' })).status, 303)
  const blocked = await call()
  assert.equal(blocked.status, 403)
  const body = (await blocked.json()) as { error: string; requestId: string }
  assert.equal(body.error, 'approval_required')
  assert.equal(f.calls.length, 0)
  assert.equal((await f.owner(`/api/requests/${body.requestId}/approve`, { duration: '30m' })).status, 200)
  assert.equal((await call()).status, 200)
  assert.equal(f.calls[0].url, '/base/things?q=1')
  assert.equal(f.calls[0].headers.authorization, `Bearer ${upstreamSecret}`)
})

test('a session cannot request a site capability', async (t) => {
  const f = await setup(t)
  const { id } = (await (
    await f.call('/_speaker/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 's', tokenHash: sha('st'), duration: '1h' }),
    })
  ).json()) as { id: string }
  await f.ownerForm(`/sessions/${id}/approve`, { duration: '1h' })
  const response = await requestSite(f, 'st', { capability: { kind: 'site', ref: 'example.com' }, reason: 'x' })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'unsupported_kind', kind: 'site' })
})

test('enforcer channel: snapshot, subject request, approval, applied, revoke', async (t) => {
  const f = await setup(t)
  const tokenHash = sha('enforcer-token')
  const { id } = (await (
    await f.call('/_speaker/enforcers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test', kinds: ['site'], tokenHash }),
    })
  ).json()) as { id: string }
  const wsUrl = `${f.url.replace('http', 'ws')}/_speaker/enforcers/ws`
  const rejected = new WebSocket(wsUrl, { headers: { authorization: 'Bearer enforcer-token' } })
  const [, response] = await once(rejected, 'unexpected-response')
  assert.equal(response.statusCode, 401)
  rejected.on('error', () => {})
  rejected.terminate()

  await f.ownerForm(`/enforcers/${id}/approve`, {})
  const ws = new WebSocket(wsUrl, { headers: { authorization: 'Bearer enforcer-token' } })
  t.after(() => ws.terminate())
  let inbox: Snapshot[] = []
  ws.on('message', (data) => inbox.push(JSON.parse(String(data))))
  const until = async (match: (snapshot: Snapshot) => unknown) => {
    for (let i = 0; i < 300; i++) {
      const found = inbox.findLast(match)
      if (found) return found
      await sleep(20)
    }
    throw new Error('no matching snapshot')
  }
  assert.equal((await until(() => true)).type, 'snapshot')

  const subject = (await (
    await f.call('/_speaker/subjects', {
      method: 'POST',
      headers: bearer('enforcer-token'),
      body: JSON.stringify({ label: 'pi' }),
    })
  ).json()) as { token: string }
  const made = await requestSite(f, subject.token, {
    capability: { kind: 'site', ref: 'example.com' },
    reason: 'docs',
    duration: '15m',
  })
  assert.equal(made.status, 201)
  const pending = (await until((s) => s.requests.length)).requests[0]
  assert.deepEqual([pending.status, pending.what, pending.reason], ['pending', 'site example.com', 'docs'])

  inbox = []
  await f.owner(`/api/requests/${pending.id}/approve`, { duration: '1h' })
  const lease = (await until((s) => s.leases.length)).leases[0]
  assert.deepEqual([lease.kind, lease.ref], ['site', 'example.com'])
  assert.equal((await f.leases())[0].state, 'granted')

  ws.send(JSON.stringify({ type: 'applied', leaseIds: [lease.id] }))
  for (let i = 0; i < 100 && (await f.leases())[0].state !== 'active'; i++) await sleep(20)
  assert.equal((await f.leases())[0].state, 'active')

  inbox = []
  await f.owner(`/api/leases/${lease.id}/revoke`)
  await until((s) => s.leases.length === 0)
  assert.deepEqual(await f.leases(), [])
})

test('a bundle request creates one lease per member with the same expiry', async (t) => {
  const bundle = [
    { kind: 'site', ref: 'a.example' },
    { kind: 'site', ref: 'b.example' },
  ]
  const f = await setup(t, { pack: bundle })
  const { subject } = await approvedEnforcer(f)
  const made = await requestSite(f, subject.token, { bundle: 'pack', reason: 'both', duration: '1d' })
  const { id } = (await made.json()) as { id: string }
  await f.owner(`/api/requests/${id}/approve`, { duration: '1d' })
  const leases = await f.leases()
  assert.deepEqual(leases.map((l) => l.ref).sort(), ['a.example', 'b.example'])
  assert.equal(new Set(leases.map((l) => l.expiresAt)).size, 1)
})

test('the proxy returns redirects without following them', async (t) => {
  const f = await setup(t)
  const { id } = (await (
    await f.call('/_speaker/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 's', tokenHash: sha('st'), duration: '1h' }),
    })
  ).json()) as { id: string }
  await f.ownerForm(`/sessions/${id}/approve`, { duration: '1h' })
  const blocked = (await (await f.call('/notes/redirect', { headers: bearer('st') })).json()) as { requestId: string }
  await f.owner(`/api/requests/${blocked.requestId}/approve`, { duration: '15m' })
  const response = await f.call('/notes/redirect', { headers: bearer('st') })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/must-not-follow')
  assert.equal(f.calls.length, 1)
})

test('admin provider saves accept a proxied same-origin browser and reject foreign form and JSON writes', async (t) => {
  const f = await setup(t)
  const input = {
    id: 'obsidian',
    baseUrl: 'https://notes.example.com/api',
    authType: 'bearer',
    secret: 'work-vault-test-key',
    read: 'approval',
    write: 'deny',
  }
  // The browser sees HTTPS while the fixture server and configured PUBLIC_URL use HTTP.
  const saved = await f.call('/admin/providers/save', {
    method: 'POST',
    headers: {
      authorization: ownerHeaders.authorization,
      origin: 'https://speaker.example.com',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-proto': 'https',
    },
    body: new URLSearchParams(input),
  })
  assert.equal(saved.status, 303)
  const page = await (await f.call('/admin?provider=obsidian', { headers: ownerHeaders })).text()
  assert.ok(page.includes('Read policy (GET / HEAD / OPTIONS)'))
  assert.ok(page.includes('Write policy (all other methods)'))
  assert.ok(page.includes('read approval · write deny'))
  assert.ok(!page.includes(input.secret))

  for (const site of ['cross-site', 'same-site', 'none', '']) {
    for (const json of [false, true]) {
      const response = await f.call('/admin/providers/save', {
        method: 'POST',
        headers: {
          authorization: ownerHeaders.authorization,
          origin: 'https://untrusted.example.com',
          ...(site ? { 'sec-fetch-site': site } : {}),
          ...(json ? { 'content-type': 'application/json' } : {}),
          // Proxy headers alone must never authorize a foreign Origin.
          'x-forwarded-host': 'untrusted.example.com',
          'x-forwarded-proto': 'https',
        },
        body: json ? JSON.stringify(input) : new URLSearchParams({ ...input, write: 'always' }),
      })
      assert.equal(response.status, 403, `${site || 'no metadata'} ${json ? 'JSON' : 'form'}`)
    }
  }
  const after = await (await f.call('/admin?provider=obsidian', { headers: ownerHeaders })).text()
  assert.ok(after.includes('read approval · write deny'))
  // Older clients still work with an explicitly configured Origin and no Fetch Metadata.
  assert.equal((await f.ownerForm('/providers/save', input)).status, 303)
})

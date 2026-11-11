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
  const upstream = createServer(async (req, res) => {
    calls.push({ url: req.url, headers: req.headers })
    if (req.url?.startsWith('/base/redirect')) return void res.writeHead(302, { location: '/must-not-follow' }).end()
    // A minimal MCP server under /mcp: one read-only tool and one destructive tool.
    if (req.url?.startsWith('/mcp') && req.method === 'POST') {
      let text = ''
      for await (const chunk of req) text += chunk
      const message = JSON.parse(text) as { id?: number; method: string }
      const result =
        message.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
          : message.method === 'tools/list'
            ? {
                tools: [
                  { name: 'get_state', annotations: { readOnlyHint: true } },
                  { name: 'delete_automation', annotations: { readOnlyHint: false, destructiveHint: true } },
                ],
              }
            : { content: [] }
      if (message.id === undefined) return void res.writeHead(202).end()
      return void res
        .writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fake-session' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    }
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
  return { url, call, owner, ownerForm, leases, calls, upstreamOrigin: `http://127.0.0.1:${port(upstream)}` }
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
    body: JSON.stringify({ label: 'big agent', llmName: 'Test LLM', tokenHash: sha('session-token'), duration: '1h' }),
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
  const guide = async () =>
    (await f.call('/_speaker/providers/notes/guide', { headers: bearer('session-token') })).text()
  assert.match(await guide(), /Read \(GET, HEAD, OPTIONS\): needs `credential notes\.read`; not approved yet\./)
  assert.equal((await f.owner(`/api/requests/${body.requestId}/approve`, { duration: '30m' })).status, 200)
  const status = (await (
    await f.call(`/_speaker/requests/${body.requestId}`, { headers: bearer('session-token') })
  ).json()) as { status: string; expiresAt: string }
  assert.equal(status.status, 'approved')
  assert.ok(Date.parse(status.expiresAt) > Date.now())
  const approved = await guide()
  assert.ok(approved.includes(`Read (GET, HEAD, OPTIONS): approved until ${status.expiresAt} (UTC).`))
  assert.match(approved, /Your session is approved until .+ \(UTC\)\./)
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
      body: JSON.stringify({ label: 's', llmName: 'Test LLM', tokenHash: sha('st'), duration: '1h' }),
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

test('bundle listing shows a caller only bundles it may request in full', async (t) => {
  const f = await setup(t, {
    pack: [{ kind: 'site', ref: 'a.example' }],
    notes: [{ kind: 'credential', ref: 'notes.read' }],
  })
  const { subject } = await approvedEnforcer(f)
  const listed = async (token: string) =>
    Object.keys(await (await f.call('/_speaker/bundles', { headers: { authorization: `Bearer ${token}` } })).json())
  assert.deepEqual((await listed(subject.token)).sort(), ['notes', 'pack'])
  const { id } = (await (
    await f.call('/_speaker/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 's', llmName: 'Test LLM', tokenHash: sha('st'), duration: '1h' }),
    })
  ).json()) as { id: string }
  await f.ownerForm(`/sessions/${id}/approve`, { duration: '1h' })
  assert.deepEqual(await listed('st'), ['notes'])
})

test('the admin saves and deletes bundles without a restart', async (t) => {
  const f = await setup(t)
  const { subject } = await approvedEnforcer(f)
  const listed = async () =>
    (await (
      await f.call('/_speaker/bundles', { headers: { authorization: `Bearer ${subject.token}` } })
    ).json()) as Record<string, { kind: string; ref: string }[]>
  const saved = await f.ownerForm('/bundles/save', { id: 'pack', members: 'site a.example\nsite b.example' })
  assert.equal(saved.status, 303)
  assert.deepEqual((await listed()).pack, [
    { kind: 'site', ref: 'a.example' },
    { kind: 'site', ref: 'b.example' },
  ])
  // Refused input redirects back to the editor with an error code, and saves nothing.
  const refused = await f.ownerForm('/bundles/save', { id: 'bad', members: 'nonsense x' })
  assert.equal(refused.headers.get('location'), '/admin?section=bundles&error=line')
  assert.equal((await listed()).bad, undefined)
  assert.equal((await f.ownerForm('/bundles/delete', { id: 'pack' })).status, 303)
  assert.deepEqual(await listed(), {})
})

test('the proxy returns redirects without following them', async (t) => {
  const f = await setup(t)
  const { id } = (await (
    await f.call('/_speaker/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 's', llmName: 'Test LLM', tokenHash: sha('st'), duration: '1h' }),
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

test('admin bundle saves list members, refuse empty or malformed input with a readable redirect, and delete', async (t) => {
  const f = await setup(t)
  const members = 'credential notes.read\nfolder ~/vault'
  assert.equal((await f.ownerForm('/bundles/save', { id: 'kit', members })).status, 303)
  const page = await (await f.call('/admin?section=bundles', { headers: ownerHeaders })).text()
  assert.ok(page.includes('~/vault') && page.includes('2 members'))
  for (const [body, code] of [
    [{ id: 'kit', members: '  \n' }, 'empty'],
    [{ id: 'kit', members: 'bogus x' }, 'line'],
    [{ id: 'bad id!', members }, 'id'],
  ] as const) {
    const response = await f.ownerForm('/bundles/save', body)
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), `/admin?section=bundles&error=${code}`)
  }
  const failed = await (await f.call('/admin?section=bundles&error=empty', { headers: ownerHeaders })).text()
  assert.ok(failed.includes('list at least one member'))
  assert.equal((await f.ownerForm('/bundles/delete', { id: 'kit' })).status, 303)
  assert.ok(!(await (await f.call('/admin?section=bundles', { headers: ownerHeaders })).text()).includes('~/vault'))
})

test('one enrollment call files the first request; approving the session grants it, and status long-polls', async (t) => {
  const f = await setup(t)
  const enrolled = await f.call('/_speaker/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'quick agent',
      llmName: 'Test LLM',
      harness: 'Test Harness',
      tokenHash: sha('quick-token'),
      duration: '1h',
      request: { capability: { kind: 'credential', ref: 'notes.read' }, reason: 'read one note', duration: '30m' },
    }),
  })
  assert.equal(enrolled.status, 201)
  const { id, requestId } = (await enrolled.json()) as { id: string; requestId: string }
  assert.ok(requestId)
  const waited = f.call(`/_speaker/sessions/${id}?wait=5`)
  await sleep(100)
  assert.equal((await f.ownerForm(`/sessions/${id}/approve`, { duration: '1h' })).status, 303)
  assert.equal(((await (await waited).json()) as { status: string }).status, 'approved')
  const mine = (await (await f.call('/_speaker/requests', { headers: bearer('quick-token') })).json()) as {
    id: string
    status: string
    expiresAt: string
  }[]
  assert.equal(mine[0].id, requestId)
  assert.equal(mine[0].status, 'approved')
  assert.ok(Date.parse(mine[0].expiresAt) > Date.now())
  assert.equal((await f.call('/notes/things', { headers: bearer('quick-token') })).status, 200)
  assert.equal((await f.call('/SKILL.md')).status, 200)
})

async function approvedSession(f: Fixture, token: string) {
  const enrolled = await f.call('/_speaker/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: token, llmName: 'Test LLM', tokenHash: sha(token), duration: '1h' }),
  })
  const { id } = (await enrolled.json()) as { id: string }
  assert.equal((await f.ownerForm(`/sessions/${id}/approve`, { duration: '1h' })).status, 303)
}

test('an always read needs no lease, counts as a use, and the guide says until when', async (t) => {
  const f = await setup(t)
  await f.ownerForm('/providers/save', {
    id: 'notes',
    baseUrl: `${f.upstreamOrigin}/base`,
    authType: 'bearer',
    read: 'always',
    write: 'approval',
  })
  await approvedSession(f, 'always-token')
  assert.equal((await f.call('/notes/x', { headers: bearer('always-token') })).status, 200)
  const page = await (await f.call('/admin?section=identities', { headers: ownerHeaders })).text()
  assert.match(page, /1 use/)
  const guide = await (await f.call('/_speaker/providers/notes/guide', { headers: bearer('always-token') })).text()
  assert.match(guide, /Read \(GET, HEAD, OPTIONS\): allowed without a request until .+ \(UTC\)\./)
})

test('path auth splices the stored secret into the upstream path and keeps it from the agent', async (t) => {
  const f = await setup(t)
  await f.ownerForm('/providers/save', {
    id: 'hook',
    baseUrl: `${f.upstreamOrigin}/api/webhook`,
    authType: 'path',
    secret: 'mcp_secret123',
    read: 'always',
    write: 'always',
  })
  await approvedSession(f, 'hook-token')
  assert.equal((await f.call('/hook', { method: 'POST', headers: bearer('hook-token'), body: '{}' })).status, 200)
  const last = f.calls.at(-1)
  assert.equal(last?.url, '/api/webhook/mcp_secret123')
  assert.equal(last?.headers.authorization, undefined)
})

test('an MCP provider classifies tool calls by their read-only hints', async (t) => {
  const f = await setup(t)
  await f.ownerForm('/providers/save', {
    id: 'ha',
    baseUrl: `${f.upstreamOrigin}/mcp`,
    authType: 'bearer',
    secret: 'ha-secret',
    read: 'always',
    write: 'approval',
    mcp: 'on',
  })
  await approvedSession(f, 'mcp-token')
  const rpc = (method: string, params: object = {}) =>
    f.call('/ha', {
      method: 'POST',
      headers: { ...bearer('mcp-token'), accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
    })
  assert.equal((await rpc('tools/list')).status, 200)
  assert.equal((await rpc('tools/call', { name: 'get_state', arguments: {} })).status, 200)
  const blocked = await rpc('tools/call', { name: 'delete_automation', arguments: {} })
  assert.equal(blocked.status, 403)
  assert.equal(((await blocked.json()) as { capability: string }).capability, 'ha.write')
  const requests = (await (await f.call('/admin/api/requests', { headers: ownerHeaders })).json()) as {
    path: string
  }[]
  assert.match(requests[0].path, /delete_automation \(destructive\)/)
})

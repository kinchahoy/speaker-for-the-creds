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
import { setOwnerPassword } from './owner.ts'

const upstreamSecret = 'secret-only-the-upstream-should-see'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
type Grant = { id: string; item: string; expiresAt: string | null; enforcement: string }
type Snapshot = {
  type: string
  grants: { id: string; agentId: string; item: string }[]
  requests: { id: string; status: string; what: string; reason: string }[]
}
type Outcome = { id: string; status: string; granted: string[]; denied: string[]; expiresAt?: string | null }
const port = (server: { address(): string | AddressInfo | null }) => (server.address() as AddressInfo).port

async function setup(t: TestContext, groups: object = {}, env: Record<string, string> = {}) {
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
  await writeFile(join(dataDir, 'groups.json'), JSON.stringify(groups))
  const app = await createApp(readConfig({ DATA_DIR: dataDir, PUBLIC_URL: 'http://localhost', ...env }))
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
  const cookie = await setOwnerPassword(call)
  const ownerHeaders = { cookie, origin: 'http://localhost', 'content-type': 'application/json' }
  const ownerForm = (path: string, body: Record<string, string>) =>
    call(`/admin${path}`, {
      method: 'POST',
      headers: { cookie, origin: ownerHeaders.origin },
      body: new URLSearchParams(body),
    })
  // The Inbox and Active panels, as the owner's page polls them.
  const live = async () => ({
    approvals: await (await call('/admin/panel/inbox', { headers: ownerHeaders })).text(),
    grants: await (await call('/admin/panel/active', { headers: ownerHeaders })).text(),
  })
  // The pending request cards, as the owner's page renders them.
  const pending = async () =>
    (await live()).approvals
      .split('<article id="request-')
      .slice(1)
      .map((card) => ({ id: card.slice(0, card.indexOf('"')), html: card }))
  // Taps Approve or Deny on a card: posts the ticked items (default all) and the items the card showed.
  const decide = async (
    id: string,
    decision: 'approve' | 'deny',
    { duration = '1h', items, shown }: { duration?: string; items?: string[]; shown?: string[] } = {},
  ) => {
    const card = (await pending()).find((c) => c.id === id)
    const listed =
      shown ?? [...(card?.html ?? '').matchAll(/name="shown" type="hidden" value="([^"]*)"/g)].map((m) => m[1])
    const body = new URLSearchParams({ duration })
    for (const item of items ?? listed) body.append('items', item)
    for (const item of listed) body.append('shown', item)
    return call(`/admin/requests/${id}/${decision}`, {
      method: 'POST',
      headers: { cookie, origin: ownerHeaders.origin },
      body,
    })
  }
  const grants = async (): Promise<Grant[]> =>
    (await live()).grants
      .split('<li id="grant-')
      .slice(1)
      .map((row) => ({
        id: row.slice(0, row.indexOf('"')),
        item: /<code>(.*?)<\/code>/.exec(row)?.[1] ?? '',
        expiresAt: /<time datetime="([^"]*)"/.exec(row)?.[1] ?? null,
        enforcement: /data-state="([a-z-]+)"/.exec(row)?.[1] ?? 'enforced',
      }))
  const saved = await ownerForm('/services/save', {
    id: 'notes',
    baseUrl: `http://127.0.0.1:${port(upstream)}/base`,
    authType: 'bearer',
    secret: upstreamSecret,
    read: 'ask',
    write: 'ask',
  })
  assert.equal(saved.status, 303)
  return {
    url,
    call,
    ownerForm,
    ownerHeaders,
    live,
    pending,
    decide,
    grants,
    calls,
    upstreamOrigin: `http://127.0.0.1:${port(upstream)}`,
  }
}
type Fixture = Awaited<ReturnType<typeof setup>>

async function approvedHost(f: Fixture, kinds = ['site']) {
  const tokenHash = sha('host-token')
  const created = await f.call('/_speaker/hosts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test', kinds, tokenHash }),
  })
  const { id } = (await created.json()) as { id: string }
  assert.equal((await f.ownerForm(`/hosts/${id}/approve`, {})).status, 303)
  const agent = await f.call('/_speaker/hosts/agents', {
    method: 'POST',
    headers: bearer('host-token'),
    body: JSON.stringify({ label: 'pi', agent: 'Test LLM · Pi on test' }),
  })
  return { id, agent: (await agent.json()) as { id: string; token: string } }
}

const hostRequest = (f: Fixture, agentId: string, body: object) =>
  f.call('/_speaker/requests', {
    method: 'POST',
    headers: bearer('host-token'),
    body: JSON.stringify({ agentId, ...body }),
  })
const askFor = (f: Fixture, token: string, body: object, headers: Record<string, string> = {}) =>
  f.call('/_speaker/requests', {
    method: 'POST',
    headers: { ...bearer(token), ...headers },
    body: JSON.stringify(body),
  })
const enroll = (f: Fixture, token: string, body: object = {}, headers: Record<string, string> = {}) =>
  f.call('/_speaker/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ label: token, agent: 'Test LLM · Test app on test', tokenHash: sha(token), ...body }),
  })
const enrolled = async (f: Fixture, token: string, headers: Record<string, string> = {}) =>
  ((await (await enroll(f, token, {}, headers)).json()) as { id: string }).id
const me = async (f: Fixture, token: string) =>
  (await f.call('/_speaker/catalog', { headers: bearer(token) })).json() as Promise<{
    agent: { status: string; kind: string }
    services: Record<string, { read: { state: string; until?: string | null }; full: { state: string } }>
    grants: { item: string; expiresAt: string | null }[]
    groups: Record<string, { description?: string; items: string[] }>
    requests: (Outcome & { want: string[] })[]
  }>
// A call that files a request and returns its id.
const firstRequest = async (f: Fixture, token: string, path = '/notes/x') =>
  ((await (await f.call(path, { headers: bearer(token) })).json()) as { request: string }).request

test('enroll with a first request, approval, then the proxy injects the credential', async (t) => {
  const f = await setup(t)
  const first = await enroll(f, 'agent-token', { want: ['notes.read'], reason: 'read one note', duration: '1h' })
  assert.equal(first.status, 201)
  const { request } = (await first.json()) as { request: Outcome & { next: string } }
  assert.equal(request.status, 'pending')
  assert.match(request.next, /Speaker-Wait/)
  assert.equal(
    ((await (await f.call('/notes/things', { headers: bearer('nope') })).json()) as { error: string }).error,
    'enroll',
  )
  const call = () => f.call('/notes/things?q=1', { headers: bearer('agent-token') })
  // The call joins the pending request instead of filing a second one.
  const blocked = await call()
  assert.equal(blocked.status, 403)
  assert.equal(((await blocked.json()) as { error: string }).error, 'approval_required')
  assert.equal((await me(f, 'agent-token')).requests.length, 1)
  assert.equal(f.calls.length, 0)
  const help = async () => (await f.call('/_speaker/help/notes', { headers: bearer('agent-token') })).text()
  assert.match(await help(), /needs `notes\.read`; not granted yet\./)
  assert.equal((await f.decide(request.id, 'approve', { duration: '30m' })).status, 303)
  const decided = (await me(f, 'agent-token')).requests[0]
  assert.deepEqual([decided.status, decided.granted, decided.denied], ['decided', ['notes.read'], []])
  assert.ok(Date.parse(decided.expiresAt ?? '') > Date.now())
  assert.ok((await help()).includes(`granted until ${decided.expiresAt} (UTC).`))
  assert.equal((await call()).status, 200)
  assert.equal(f.calls[0].url, '/base/things?q=1')
  assert.equal(f.calls[0].headers.authorization, `Bearer ${upstreamSecret}`)
})

test('the owner decides per item: unticked items are denied, and .full covers reads', async (t) => {
  const f = await setup(t)
  await enroll(f, 'tok')
  const made = (await (
    await askFor(f, 'tok', { want: ['notes.read', 'notes.full'], reason: 'edit' })
  ).json()) as Outcome
  assert.equal(made.status, 'pending')
  assert.equal((await f.decide(made.id, 'approve', { duration: '1h', items: ['notes.full'] })).status, 303)
  const [request] = (await me(f, 'tok')).requests
  assert.deepEqual([request.granted, request.denied], [['notes.full'], ['notes.read']])
  assert.deepEqual(
    (await f.grants()).map((g) => g.item),
    ['notes.full'],
  )
  // The full grant answers a read and a write without further requests.
  assert.equal((await f.call('/notes/x', { headers: bearer('tok') })).status, 200)
  assert.equal((await f.call('/notes/x', { method: 'PUT', headers: bearer('tok'), body: '{}' })).status, 200)
  assert.equal((await me(f, 'tok')).services.notes.read.state, 'granted')
})

test('a direct agent cannot request sandbox-only items, and invalid input lists what is accepted', async (t) => {
  const f = await setup(t)
  await enroll(f, 'st')
  const site = await askFor(f, 'st', { want: ['site:example.com'], reason: 'x' })
  assert.equal(site.status, 400)
  assert.equal(((await site.json()) as { error: string }).error, 'invalid')
  const malformed = (await (await askFor(f, 'st', { want: ['ssh nas'], reason: 'x' })).json()) as {
    fields: { message: string }[]
  }
  assert.match(malformed.fields[0].message, /group:<name>/)
  const duration = (await (await askFor(f, 'st', { want: ['notes.read'], reason: 'x', duration: '15m' })).json()) as {
    fields: { accepted: string[] }[]
  }
  assert.deepEqual(duration.fields[0].accepted, ['30m', '1h', '2h', '1d', '30d'])
  const unknown = await askFor(f, 'st', { want: ['group:nothing'], reason: 'x' })
  assert.equal(unknown.status, 400)
})

test('sandbox host channel: snapshot, agent request, approval, applied, revoke', async (t) => {
  const f = await setup(t)
  const tokenHash = sha('host-token')
  const { id } = (await (
    await f.call('/_speaker/hosts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test', kinds: ['site'], tokenHash }),
    })
  ).json()) as { id: string }
  const wsUrl = `${f.url.replace('http', 'ws')}/_speaker/hosts/ws`
  const rejected = new WebSocket(wsUrl, { headers: { authorization: 'Bearer host-token' } })
  const [, response] = await once(rejected, 'unexpected-response')
  assert.equal(response.statusCode, 401)
  rejected.on('error', () => {})
  rejected.terminate()

  await f.ownerForm(`/hosts/${id}/approve`, {})
  const ws = new WebSocket(wsUrl, { headers: { authorization: 'Bearer host-token' } })
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

  const agent = (await (
    await f.call('/_speaker/hosts/agents', {
      method: 'POST',
      headers: bearer('host-token'),
      body: JSON.stringify({ label: 'pi', agent: 'Test LLM · Pi on test' }),
    })
  ).json()) as { id: string; token: string }
  // The agent's token is bound to the host's address; the agent needs no card of its own.
  assert.equal((await me(f, agent.token)).agent.kind, 'sandboxed')
  const made = await hostRequest(f, agent.id, { want: ['site:example.com'], reason: 'docs', duration: '30m' })
  assert.equal(made.status, 202)
  const pending = (await until((s) => s.requests.length)).requests[0]
  assert.deepEqual([pending.status, pending.what, pending.reason], ['pending', 'site:example.com', 'docs'])

  inbox = []
  await f.decide(pending.id, 'approve', { duration: '1h' })
  const grant = (await until((s) => s.grants.length)).grants[0]
  assert.deepEqual([grant.item, grant.agentId], ['site:example.com', agent.id])
  assert.equal((await f.grants())[0].enforcement, 'sent')

  ws.send(JSON.stringify({ type: 'applied', grantIds: [grant.id] }))
  for (let i = 0; i < 100 && (await f.grants())[0].enforcement !== 'enforced'; i++) await sleep(20)
  assert.equal((await f.grants())[0].enforcement, 'enforced')

  inbox = []
  await f.ownerForm('/grants/revoke', { id: grant.id })
  await until((s) => s.grants.length === 0)
  assert.deepEqual(await f.grants(), [])

  // The host ends its agent: the token answers `denied` afterwards, not `enroll`.
  const gone = await f.call(`/_speaker/hosts/agents/${agent.id}`, { method: 'DELETE', headers: bearer('host-token') })
  assert.equal(gone.status, 200)
  assert.equal((await f.call('/_speaker/catalog', { headers: bearer(agent.token) })).status, 403)
})

test('GET /hosts/self confirms an approved host, and refuses pending hosts and agent tokens', async (t) => {
  const f = await setup(t)
  const created = await f.call('/_speaker/hosts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test', kinds: ['site'], tokenHash: sha('host-token') }),
  })
  const { id } = (await created.json()) as { id: string }
  const pending = await f.call('/_speaker/hosts/self', { headers: bearer('host-token') })
  assert.equal(pending.status, 401)
  assert.equal(((await pending.json()) as { error: string }).error, 'approval_required')
  assert.equal((await f.ownerForm(`/hosts/${id}/approve`, {})).status, 303)
  const self = await f.call('/_speaker/hosts/self', { headers: bearer('host-token') })
  assert.equal(self.status, 200)
  assert.deepEqual(await self.json(), { id, name: 'test', status: 'approved' })
  const agent = (await (
    await f.call('/_speaker/hosts/agents', {
      method: 'POST',
      headers: bearer('host-token'),
      body: JSON.stringify({ label: 'pi' }),
    })
  ).json()) as { token: string }
  const denied = await f.call('/_speaker/hosts/self', { headers: bearer(agent.token) })
  assert.equal(denied.status, 403)
  assert.equal(((await denied.json()) as { error: string }).error, 'denied')
})

test('a sandbox host records the shares it reports, and a grant is applying for the agent until the host reports it', async (t) => {
  const f = await setup(t)
  const { agent } = await approvedHost(f, ['site', 'folder'])
  const ws = new WebSocket(`${f.url.replace('http', 'ws')}/_speaker/hosts/ws`, {
    headers: { authorization: 'Bearer host-token' },
  })
  t.after(() => ws.terminate())
  const inbox: Snapshot[] = []
  ws.on('message', (data) => inbox.push(JSON.parse(String(data))))
  await once(ws, 'open')

  ws.send(
    JSON.stringify({
      type: 'shares',
      shares: [
        { name: 'documents', mount: true },
        { name: 'ghost', mount: false },
      ],
    }),
  )
  for (let i = 0; i < 100 && !(await f.live()).grants.includes('documents (VM mount)'); i++) await sleep(20)
  assert.match((await f.live()).grants, /shares: documents \(VM mount\), ghost \(no VM mount\)/)

  // Asked over the agent's own token and held until decided: the item is granted for the agent only once reported.
  const held = askFor(f, agent.token, { want: ['site:example.com'], reason: 'docs' }, { 'speaker-wait': '10' })
  let card = (await f.pending())[0]
  for (let i = 0; i < 100 && !card; i++) {
    await sleep(20)
    card = (await f.pending())[0]
  }
  await f.decide(card.id, 'approve')
  let grant: Snapshot['grants'][number] | undefined
  for (let i = 0; i < 100 && !grant; i++) {
    await sleep(20)
    grant = inbox.findLast((s) => s.grants.length)?.grants[0]
  }
  assert.ok(grant)
  const state = async () =>
    (await me(f, agent.token)).grants.map((g) => [g.item, (g as { applying?: boolean }).applying])
  assert.deepEqual(await state(), [['site:example.com', true]])
  ws.send(JSON.stringify({ type: 'applied', grantIds: [grant.id] }))
  const answered = (await (await held).json()) as Outcome & { applying?: string[] }
  assert.deepEqual([answered.status, answered.granted, answered.applying], ['decided', ['site:example.com'], undefined])
  assert.deepEqual(await state(), [['site:example.com', undefined]])
})

test('a group request creates one grant per item with the same expiry', async (t) => {
  const f = await setup(t, { pack: { items: ['site:a.example', 'site:b.example'] } })
  const { agent } = await approvedHost(f)
  const made = (await (
    await hostRequest(f, agent.id, { want: ['group:pack'], reason: 'both', duration: '1d' })
  ).json()) as Outcome
  await f.decide(made.id, 'approve', { duration: '1d' })
  const grants = await f.grants()
  assert.deepEqual(grants.map((g) => g.item).sort(), ['site:a.example', 'site:b.example'])
  assert.equal(new Set(grants.map((g) => g.expiresAt)).size, 1)
})

test('groups are offered only when every item suits the agent, and groups may mix kinds', async (t) => {
  const f = await setup(t, {
    pack: { items: ['site:a.example'] },
    notes: { description: 'Read notes', items: ['notes.read'] },
    mixed: { items: ['notes.read', 'site:a.example', 'mcp:context7'] },
  })
  const { agent } = await approvedHost(f, ['site', 'mcp'])
  assert.deepEqual(Object.keys((await me(f, agent.token)).groups).sort(), ['mixed', 'notes', 'pack'])
  await enroll(f, 'st')
  const direct = await me(f, 'st')
  assert.deepEqual(direct.groups, { notes: { description: 'Read notes', items: ['notes.read'] } })
  assert.equal((await askFor(f, 'st', { want: ['group:pack'], reason: 'x' })).status, 400)
})

test('the admin saves and deletes groups without a restart, and refuses malformed input with a readable redirect', async (t) => {
  const f = await setup(t)
  await enroll(f, 'st')
  const listed = async () => (await me(f, 'st')).groups
  const saved = await f.ownerForm('/groups/save', {
    id: 'pair',
    description: ' Two services ',
    items: 'notes.read\nnotes.full',
  })
  assert.equal(saved.status, 303)
  assert.deepEqual((await listed()).pair, { description: 'Two services', items: ['notes.read', 'notes.full'] })
  const page = await (await f.call('/admin?section=groups', { headers: f.ownerHeaders })).text()
  assert.ok(page.includes('Two services') && page.includes('2 items'))
  // A blank description is dropped rather than stored.
  await f.ownerForm('/groups/save', { id: 'pair', description: '', items: 'notes.read' })
  assert.deepEqual((await listed()).pair, { items: ['notes.read'] })
  for (const [body, code] of [
    [{ id: 'bad', items: '  \n' }, 'empty'],
    [{ id: 'bad', items: 'nonsense x' }, 'line'],
    [{ id: 'bad', items: 'group:other' }, 'line'],
    [{ id: 'bad id!', items: 'notes.read' }, 'id'],
  ] as const) {
    const response = await f.ownerForm('/groups/save', body)
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), `/admin?section=groups&error=${code}`)
  }
  assert.equal((await listed()).bad, undefined)
  const failed = await (await f.call('/admin?section=groups&error=empty', { headers: f.ownerHeaders })).text()
  assert.ok(failed.includes('list at least one item'))
  assert.equal((await f.ownerForm('/groups/delete', { id: 'pair' })).status, 303)
  assert.deepEqual(await listed(), {})
})

test('the proxy returns redirects without following them', async (t) => {
  const f = await setup(t)
  await enroll(f, 'st')
  const request = await firstRequest(f, 'st', '/notes/redirect')
  await f.decide(request, 'approve', { duration: '30m' })
  const response = await f.call('/notes/redirect', { headers: bearer('st') })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/must-not-follow')
  assert.equal(f.calls.length, 1)
})

test('admin service saves accept a proxied same-origin browser and reject foreign form and JSON writes', async (t) => {
  const f = await setup(t)
  const input = {
    id: 'obsidian',
    baseUrl: 'https://notes.example.com/api',
    authType: 'bearer',
    secret: 'work-vault-test-key',
    read: 'ask',
    write: 'never',
  }
  // The browser sees HTTPS while the fixture server and configured PUBLIC_URL use HTTP.
  const saved = await f.call('/admin/services/save', {
    method: 'POST',
    headers: {
      cookie: f.ownerHeaders.cookie,
      origin: 'https://speaker.example.com',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-proto': 'https',
    },
    body: new URLSearchParams(input),
  })
  assert.equal(saved.status, 303)
  const page = await (await f.call('/admin?service=obsidian', { headers: f.ownerHeaders })).text()
  assert.ok(page.includes('Read rule (GET / HEAD / OPTIONS)'))
  assert.ok(page.includes('Write rule (all other methods)'))
  assert.ok(page.includes('read ask · write never'))
  assert.ok(!page.includes(input.secret))

  for (const site of ['cross-site', 'same-site', 'none', '']) {
    for (const json of [false, true]) {
      const response = await f.call('/admin/services/save', {
        method: 'POST',
        headers: {
          cookie: f.ownerHeaders.cookie,
          origin: 'https://untrusted.example.com',
          ...(site ? { 'sec-fetch-site': site } : {}),
          ...(json ? { 'content-type': 'application/json' } : {}),
          // Proxy headers alone must never authorize a foreign Origin.
          'x-forwarded-host': 'untrusted.example.com',
          'x-forwarded-proto': 'https',
        },
        body: json ? JSON.stringify(input) : new URLSearchParams({ ...input, write: 'ask' }),
      })
      assert.equal(response.status, 403, `${site || 'no metadata'} ${json ? 'JSON' : 'form'}`)
    }
  }
  // A form post with no Origin says why it was refused.
  const missing = await f.call('/admin/services/save', {
    method: 'POST',
    headers: { cookie: f.ownerHeaders.cookie },
    body: new URLSearchParams({ ...input, write: 'ask' }),
  })
  assert.equal(missing.status, 403)
  assert.match(await missing.text(), /^Cross-origin form post blocked: send an Origin header matching http/)
  const after = await (await f.call('/admin?service=obsidian', { headers: f.ownerHeaders })).text()
  assert.ok(after.includes('read ask · write never'))
  // Older clients still work with an explicitly configured Origin and no Fetch Metadata.
  assert.equal((await f.ownerForm('/services/save', input)).status, 303)
})

test('enrollment with Speaker-Wait holds until the owner decides and answers per item', async (t) => {
  const f = await setup(t)
  const held = enroll(
    f,
    'quick-token',
    { want: ['notes.read'], reason: 'read one note', duration: '30m' },
    { 'speaker-wait': '5' },
  )
  let waiting: { id: string }[] = []
  while (!waiting.length) {
    await sleep(50)
    waiting = await f.pending()
  }
  assert.equal((await f.decide(waiting[0].id, 'approve', { duration: '1h' })).status, 303)
  const response = await held
  const { id, request } = (await response.json()) as { id: string; request: Outcome }
  assert.deepEqual([request.status, request.granted, request.denied], ['decided', ['notes.read'], []])
  assert.ok(Date.parse(request.expiresAt ?? '') > Date.now())
  // The same token enrolled again returns the same agent.
  const again = await enroll(f, 'quick-token')
  assert.equal(again.status, 200)
  assert.equal(((await again.json()) as { id: string }).id, id)
  assert.equal((await f.call('/notes/things', { headers: bearer('quick-token') })).status, 200)
  assert.equal((await f.call('/skill.md')).status, 200)
})

test('enrollment may carry an empty want, and /catalog then shows where the agent stands', async (t) => {
  const f = await setup(t)
  assert.equal((await enroll(f, 'tok')).status, 201)
  const view = await me(f, 'tok')
  assert.deepEqual([view.agent.status, view.agent.kind, view.grants, view.requests], ['idle', 'direct', [], []])
  assert.deepEqual(view.services.notes.read, { state: 'ask' })
  assert.equal(((await (await f.call('/_speaker/catalog')).json()) as { error: string }).error, 'enroll')
})

test('an open read needs no grant or card, is never listed in /catalog, and counts as a use', async (t) => {
  const f = await setup(t)
  await f.ownerForm('/services/save', {
    id: 'lights',
    baseUrl: `${f.upstreamOrigin}/base`,
    authType: 'bearer',
    secret: 's',
    read: 'open',
    write: 'ask',
  })
  await enrolled(f, 'open-token')
  assert.equal((await f.call('/lights/x', { headers: bearer('open-token') })).status, 200)
  assert.ok(!('lights' in (await me(f, 'open-token')).services))
  assert.deepEqual(await f.pending(), [])
  assert.match(await (await f.call(`/admin?section=agents`, { headers: f.ownerHeaders })).text(), /1 use/)
  // Asking for the open read is answered at once without a card; writes still need a grant.
  const asked = (await (await askFor(f, 'open-token', { want: ['lights.read'], reason: 'x' })).json()) as Outcome
  assert.deepEqual([asked.status, asked.granted], ['decided', ['lights.read']])
  assert.equal((await f.call('/lights/x', { method: 'POST', headers: bearer('open-token'), body: '{}' })).status, 403)
  // Once the agent holds a grant for the service, it is listed even though its reads are open.
  const write = (await (await askFor(f, 'open-token', { want: ['lights.full'], reason: 'x' })).json()) as Outcome
  await f.decide(write.id, 'approve')
  assert.equal((await me(f, 'open-token')).services.lights.full.state, 'granted')
})

test('a card lists groups and loose items, and Approve decides only the items it showed', async (t) => {
  const f = await setup(t, { dev: { description: 'Notes work', items: ['notes.read', 'notes.full'] } })
  await f.ownerForm('/services/save', {
    id: 'extra',
    baseUrl: `${f.upstreamOrigin}/base`,
    authType: 'bearer',
    secret: 's',
    read: 'ask',
    write: 'ask',
  })
  await enroll(f, 'tok')
  await askFor(f, 'tok', { want: ['group:dev', 'extra.read'], reason: 'work', duration: '1d' })
  const [card] = await f.pending()
  assert.match(card.html, /<strong>dev<\/strong> <small>Notes work · 2 items/)
  assert.match(card.html, /<option value="1d" selected>/)
  assert.match(card.html, /<label class="risky"><input type="checkbox" name="items" value="notes.full"/)
  assert.match(
    card.html,
    /<legend>Not in a group<\/legend><label class=""><input type="checkbox" name="items" value="extra.read"/,
  )
  // A different set of items is a request, and a card, of its own: it is not part of this decision.
  await askFor(f, 'tok', { want: ['extra.full'], reason: 'work' })
  assert.equal((await f.pending()).length, 2)
  assert.equal(
    (
      await f.decide(card.id, 'approve', {
        items: ['notes.read', 'extra.read'],
        shown: ['notes.read', 'notes.full', 'extra.read'],
      })
    ).status,
    303,
  )
  const [request, second] = (await me(f, 'tok')).requests
  assert.deepEqual(
    [request.status, request.granted, request.denied],
    ['decided', ['notes.read', 'extra.read'], ['notes.full']],
  )
  assert.deepEqual([second.status, second.granted, second.denied], ['pending', [], []])
  // A card that was already decided decides nothing more.
  assert.equal((await f.decide(card.id, 'deny', { shown: ['extra.full'] })).status, 409)
  assert.equal((await f.decide(second.id, 'deny')).status, 303)
  const [, done] = (await me(f, 'tok')).requests
  assert.deepEqual([done.status, done.denied], ['decided', ['extra.full']])
})

test('the admin pages have no JSON routes', async (t) => {
  const f = await setup(t)
  for (const path of ['/admin/api/requests', '/admin/api/grants'])
    assert.equal((await f.call(path, { headers: f.ownerHeaders })).status, 404)
  // A live panel polls with the hash of what it shows: unchanged answers 204, a new request answers the new panel.
  const poll = /hx-get="([^"]+)"/.exec(await (await f.call('/admin', { headers: f.ownerHeaders })).text())?.[1] ?? ''
  assert.equal((await f.call(poll, { headers: f.ownerHeaders })).status, 204)
  await enroll(f, 'poll-token', { want: ['notes.read'], reason: 'poll' })
  assert.match(await (await f.call(poll, { headers: f.ownerHeaders })).text(), /<article id="request-/)
  assert.equal((await f.call('/admin/assets/htmx.js')).status, 200)
  const css = await f.call('/admin/assets/open-props.css')
  assert.match(css.headers.get('content-type') ?? '', /text\/css/)
  assert.match(await css.text(), /--indigo-7:/)
  const icons = await f.call('/admin/assets/icons.svg')
  assert.match(icons.headers.get('content-type') ?? '', /image\/svg/)
  assert.match(await icons.text(), /<symbol id="i-secret"/)
})

test('a service set to never answers denied at once, and a POST read path counts as a read', async (t) => {
  const f = await setup(t)
  await f.ownerForm('/services/save', {
    id: 'vault',
    baseUrl: `${f.upstreamOrigin}/base`,
    authType: 'bearer',
    secret: 's',
    read: 'ask',
    write: 'never',
    readPaths: '/search\n',
  })
  await enroll(f, 'tok')
  const blocked = await f.call('/vault/x', { method: 'PUT', headers: bearer('tok'), body: '{}' })
  assert.equal(blocked.status, 403)
  assert.equal(((await blocked.json()) as { error: string }).error, 'denied')
  const full = (await (await askFor(f, 'tok', { want: ['vault.full'], reason: 'x' })).json()) as Outcome
  assert.deepEqual([full.status, full.denied], ['decided', ['vault.full']])
  // POST to a listed read path files a read request, not a full one.
  const search = await f.call('/vault/search', { method: 'POST', headers: bearer('tok'), body: '{}' })
  assert.equal(((await search.json()) as { item: string }).item, 'vault.read')
  const other = await f.call('/vault/other', { method: 'POST', headers: bearer('tok'), body: '{}' })
  assert.equal(other.status, 403)
  assert.equal(((await other.json()) as { error: string }).error, 'denied')
})

test('path auth splices the stored secret into the upstream path and keeps it from the agent', async (t) => {
  const f = await setup(t)
  await f.ownerForm('/services/save', {
    id: 'hook',
    baseUrl: `${f.upstreamOrigin}/api/webhook`,
    authType: 'path',
    secret: 'mcp_secret123',
    read: 'open',
    write: 'ask',
  })
  await enrolled(f, 'hook-token')
  assert.equal((await f.call('/hook', { headers: bearer('hook-token') })).status, 200)
  const last = f.calls.at(-1)
  assert.equal(last?.url, '/api/webhook/mcp_secret123')
  assert.equal(last?.headers.authorization, undefined)
})

test('an MCP service classifies tool calls by their read-only hints', async (t) => {
  const f = await setup(t)
  await f.ownerForm('/services/save', {
    id: 'ha',
    baseUrl: `${f.upstreamOrigin}/mcp`,
    authType: 'bearer',
    secret: 'ha-secret',
    read: 'open',
    write: 'ask',
    mcp: 'on',
  })
  await enrolled(f, 'mcp-token')
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
  assert.equal(((await blocked.json()) as { item: string }).item, 'ha.full')
  const requests = await f.pending()
  assert.match(requests[0].html, /delete_automation \(destructive\)/)
})

test('the log lists proxied calls per agent, with no grant for an open call', async (t) => {
  const f = await setup(t)
  await f.ownerForm('/services/save', {
    id: 'open',
    baseUrl: `${f.upstreamOrigin}/base`,
    authType: 'bearer',
    secret: 's',
    read: 'open',
    write: 'ask',
  })
  const id = await enrolled(f, 'log-token')
  for (const path of ['/open/first', '/open/second'])
    assert.equal((await f.call(`${path}?k=hidden`, { headers: bearer('log-token') })).status, 200)
  const page = await (await f.call(`/admin/log?agent=${id}`, { headers: f.ownerHeaders })).text()
  assert.match(page, /GET \/first/)
  assert.match(page, /GET \/second/)
  assert.match(page, /open/)
  assert.doesNotMatch(page, /k=hidden|127\.0\.0\.1:\d+\/base/)
})

test('enrollment refuses the empty-token hash, and 401s say what to do next', async (t) => {
  const f = await setup(t)
  assert.equal((await enroll(f, '')).status, 400)
  const first = (await (await enroll(f, 'tok')).json()) as { id: string; next: string }
  assert.equal(first.next, 'GET /_speaker/catalog')
  const unknown = await f.call('/notes/x', { headers: bearer('nope') })
  assert.equal(unknown.status, 401)
  assert.equal(unknown.headers.get('www-authenticate'), 'Bearer realm="speaker"')
  assert.equal(unknown.headers.get('link'), '</skill.md>; rel="help"')
  assert.equal(((await unknown.json()) as { error: string }).error, 'enroll')
})

test('Speaker-Wait holds a call until approval; without it the call answers at once', async (t) => {
  const f = await setup(t)
  await enrolled(f, 'tok')
  const immediate = Date.now()
  assert.equal((await f.call('/notes/doc', { headers: bearer('tok') })).status, 403)
  assert.ok(Date.now() - immediate < 400)
  const held = f.call('/notes/doc', {
    headers: { ...bearer('tok'), 'speaker-wait': '10', 'speaker-reason': 'read doc' },
  })
  let listed: { id: string; html: string }[] = []
  while (!listed.some((r) => r.html.includes('read doc'))) {
    await sleep(100)
    listed = await f.pending()
  }
  assert.equal(listed.length, 1)
  assert.equal((await f.decide(listed[0].id, 'approve', { duration: '30m' })).status, 303)
  const response = await held
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(f.calls.at(-1)?.headers['speaker-wait'], undefined)
  assert.equal(f.calls.at(-1)?.headers['speaker-reason'], undefined)
})

test('the third denial of an item locks it with an ISO retry_after; other items and earlier denials still ask', async (t) => {
  const f = await setup(t)
  await enrolled(f, 'tok')
  for (const strike of [1, 2, 3]) {
    const asked = await f.call('/notes/x', { headers: bearer('tok') })
    const { request, error } = (await asked.json()) as { request: string; error: string }
    assert.equal(error, 'approval_required', `denial ${strike} was still asked`)
    assert.equal((await f.decide(request, 'deny')).status, 303)
  }
  const locked = await f.call('/notes/x', { headers: bearer('tok') })
  const body = (await locked.json()) as { error: string; next: string; retry_after: string }
  assert.equal(locked.status, 403)
  assert.equal(body.error, 'denied')
  assert.equal(body.next, 'Stop: the owner denied this request.')
  assert.equal(new Date(body.retry_after).toISOString(), body.retry_after)
  const wait = Date.parse(body.retry_after) - Date.now()
  assert.ok(wait > 14 * 60_000 && wait <= 15 * 60_000)
  const direct = (await (await askFor(f, 'tok', { want: ['notes.read'], reason: 'r' })).json()) as Outcome & {
    retry_after: string
  }
  assert.deepEqual([direct.status, direct.denied, direct.retry_after], ['decided', ['notes.read'], body.retry_after])
  // The lock is per item: a write is still asked, even in the same request as the locked read.
  const mixed = (await (await askFor(f, 'tok', { want: ['notes.read', 'notes.full'], reason: 'r' })).json()) as Outcome
  assert.deepEqual([mixed.status, mixed.denied], ['pending', ['notes.read']])
})

test('services without a key are hidden from agents and cannot be requested', async (t) => {
  const f = await setup(t)
  await enroll(f, 'tok')
  assert.ok(!('karakeep' in (await me(f, 'tok')).services))
  const refused = await askFor(f, 'tok', { want: ['karakeep.read'], reason: 'r' })
  assert.equal(refused.status, 400)
  assert.equal(((await refused.json()) as { error: string }).error, 'invalid')
})

test('agents cannot extend; the owner extends a grant by its granted span', async (t) => {
  const f = await setup(t)
  await enrolled(f, 'tok')
  const request = await firstRequest(f, 'tok')
  await f.decide(request, 'approve', { duration: '30m' })
  for (const path of [`/_speaker/requests/${request}/extend`, '/_speaker/grants/extend']) {
    const gone = await f.call(path, { method: 'POST', headers: bearer('tok'), body: '{"duration":"30m"}' })
    assert.equal(gone.status, 404)
  }
  const [before] = await f.grants()
  assert.equal((await f.ownerForm('/grants/extend', { id: before.id })).status, 303)
  const [after] = await f.grants()
  assert.equal(Date.parse(after.expiresAt ?? '') - Date.parse(before.expiresAt ?? ''), 1_800_000)
  const outcome = (await me(f, 'tok')).requests[0]
  assert.equal(outcome.expiresAt, after.expiresAt)
})

test('revoking an agent ends its grants, and its token then answers denied rather than enroll', async (t) => {
  const f = await setup(t)
  const id = await enrolled(f, 'tok')
  await f.decide(await firstRequest(f, 'tok'), 'approve', { duration: '1h' })
  assert.equal((await f.call('/notes/x', { headers: bearer('tok') })).status, 200)
  assert.equal((await f.ownerForm(`/agents/${id}/revoke`, {})).status, 303)
  assert.deepEqual(await f.grants(), [])
  const after = await f.call('/notes/x', { headers: bearer('tok') })
  assert.equal(after.status, 403)
  const body = (await after.json()) as { error: string; next: string }
  assert.deepEqual([body.error, body.next], ['denied', 'Stop: the owner revoked this agent. Tell the user.'])
  // The revoked token cannot enroll again (and so cannot reach the owner with new cards); a new token can.
  assert.equal((await enroll(f, 'tok')).status, 403)
  assert.equal((await enroll(f, 'tok2')).status, 201)
})

test('a sandbox host token works only from the address it registered from', async (t) => {
  const f = await setup(t, {}, { TRUSTED_PROXY: '127.0.0.1' })
  const from = (address: string) => ({ 'x-forwarded-for': address })
  const created = await f.call('/_speaker/hosts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...from('100.64.0.7') },
    body: JSON.stringify({ name: 'test', kinds: ['site'], tokenHash: sha('host-token') }),
  })
  const { id } = (await created.json()) as { id: string }
  assert.equal((await f.ownerForm(`/hosts/${id}/approve`, {})).status, 303)
  const createAgent = (address: string) =>
    f.call('/_speaker/hosts/agents', {
      method: 'POST',
      headers: { ...bearer('host-token'), ...from(address) },
      body: JSON.stringify({ label: 'pi', agent: 'Test LLM · Pi on test' }),
    })
  const stolen = await createAgent('6.6.6.6')
  assert.equal(stolen.status, 401)
  assert.equal(((await stolen.json()) as { error: string }).error, 'register')
  assert.equal((await createAgent('100.64.0.7')).status, 201)
})

test('an agent token works only from the address it enrolled from, and X-Forwarded-For is ignored from strangers', async (t) => {
  const f = await setup(t)
  await enrolled(f, 'tok', { 'x-forwarded-for': '100.64.0.7' })
  // Bound to the socket address (127.0.0.1); a spoofed header changes nothing.
  const spoofed = await f.call('/_speaker/catalog', { headers: { ...bearer('tok'), 'x-forwarded-for': '1.2.3.4' } })
  assert.equal(spoofed.status, 200)
})

test('a trusted proxy names the caller with the last X-Forwarded-For entry', async (t) => {
  const f = await setup(t, {}, { TRUSTED_PROXY: '127.0.0.1' })
  const from = (chain: string) => ({ 'x-forwarded-for': chain })
  await enrolled(f, 'tok', from('6.6.6.6, 100.64.0.7'))
  const home = await f.call('/_speaker/catalog', { headers: { ...bearer('tok'), ...from('9.9.9.9, 100.64.0.7') } })
  assert.equal(home.status, 200)
  const away = await f.call('/_speaker/catalog', { headers: { ...bearer('tok'), ...from('100.64.0.7, 100.64.0.9') } })
  assert.equal(away.status, 401)
  assert.equal(((await away.json()) as { error: string }).error, 'enroll')
})

test('public discovery answers without a token, uses the caller address, and names no service or group', async (t) => {
  const f = await setup(t, { secretgroup: { items: ['notes.read'] } })
  const root = await (await f.call('/')).text()
  assert.ok(
    root.includes('name: access-and-creds') &&
      root.includes(`${f.url}/_speaker/help`) &&
      !root.includes('$SPEAKER_URL'),
  )
  assert.ok((await f.call('/skill.md')).headers.get('etag'))
  const help = await (await f.call('/_speaker/help')).text()
  assert.ok(help.includes(`${f.url}/_speaker/agents`))
  assert.ok(!help.includes('$SPEAKER_URL') && !help.includes('secretgroup') && !help.includes('notes'))
  // Removed discovery routes are not served: unknown paths fall through to authentication.
  assert.equal((await f.call('/llms.txt')).status, 401)
})

test('the sign-in page warns about plain HTTP only for a caller that is not on loopback', async (t) => {
  const f = await setup(t, {}, { TRUSTED_PROXY: '127.0.0.1' })
  const page = async (headers: Record<string, string>) => (await f.call('/admin', { headers })).text()
  const away = { 'x-forwarded-for': '192.168.1.9' }
  assert.doesNotMatch(await page({}), /unencrypted/)
  assert.match(await page(away), /unencrypted/)
  assert.doesNotMatch(await page({ ...away, 'x-forwarded-proto': 'https' }), /unencrypted/)
})

test('a request can be watched by id, before and after the decision, only by its agent', async (t) => {
  const f = await setup(t)
  await enroll(f, 'tok')
  await enroll(f, 'other')
  const filed = (await (await askFor(f, 'tok', { want: ['notes.read'], reason: 'work' })).json()) as Outcome
  const watch = (token: string) => f.call(`/_speaker/requests/${filed.id}`, { headers: bearer(token) })
  const pending = await watch('tok')
  assert.equal(pending.status, 202)
  assert.equal(((await pending.json()) as Outcome).status, 'pending')
  assert.equal((await watch('other')).status, 404)
  assert.equal((await f.decide(filed.id, 'approve')).status, 303)
  const decided = await watch('tok')
  assert.equal(decided.status, 200)
  assert.deepEqual(((await decided.json()) as Outcome).granted, ['notes.read'])
})

test('each request is its own; posting exactly the same items again joins the pending one', async (t) => {
  const f = await setup(t)
  await enroll(f, 'tok')
  const ask = async (want: string[]) => (await (await askFor(f, 'tok', { want, reason: 'work' })).json()) as Outcome
  const read = await ask(['notes.read'])
  assert.equal((await ask(['notes.read'])).id, read.id)
  const full = await ask(['notes.full'])
  assert.notEqual(full.id, read.id)
  assert.equal((await ask(['notes.full'])).id, full.id)
  // Approving one leaves the other waiting, and each reply covers only its own items.
  assert.equal((await f.decide(read.id, 'approve')).status, 303)
  const [first, second] = (await me(f, 'tok')).requests
  assert.deepEqual([first.status, first.granted, first.denied], ['decided', ['notes.read'], []])
  assert.deepEqual([second.status, second.granted], ['pending', []])
})

test('names an agent may not ask for are refused with the real ones, before anything reaches the owner', async (t) => {
  const f = await setup(t, { dev: { items: ['notes.read'] } })
  await enroll(f, 'st')
  const refused = async (token: string, want: string[]) => {
    const response = await askFor(f, token, { want, reason: 'x' })
    assert.equal(response.status, 400)
    return (await response.json()) as { error: string; message: string; next: string }
  }
  const service = await refused('st', ['notes.read', 'nosuch.read'])
  assert.equal(service.error, 'invalid')
  assert.match(
    service.message,
    /^nosuch\.read is not something you can ask for\. Services you can ask for: .*notes\.read/,
  )
  assert.equal(service.next, 'GET /_speaker/catalog')
  assert.match((await refused('st', ['group:nope'])).message, /Groups you can ask for: group:dev\./)
  assert.equal((await me(f, 'st')).requests.length, 0)
  // A first request with a bad name enrolls nothing: the token stays unknown.
  assert.equal((await enroll(f, 'fresh', { want: ['nosuch.read'], reason: 'x' })).status, 400)
  assert.notEqual((await f.call('/_speaker/catalog', { headers: bearer('fresh') })).status, 200)
  assert.equal((await f.pending()).length, 0)
})

test('a sandbox host reports its catalog: unknown ext and mcp ids are refused, and an extension brings its sites', async (t) => {
  const f = await setup(t)
  const { agent } = await approvedHost(f, ['site', 'ext', 'mcp'])
  const ws = new WebSocket(`${f.url.replace('http', 'ws')}/_speaker/hosts/ws`, {
    headers: { authorization: 'Bearer host-token' },
  })
  t.after(() => ws.terminate())
  await once(ws, 'open')
  ws.send(
    JSON.stringify({
      type: 'catalog',
      mcps: [{ id: 'files', label: 'Files', tools: ['read_file'] }],
      extensions: [
        {
          id: 'web',
          label: 'Web search',
          description: 'Search the web',
          tools: ['web_search'],
          sites: ['search.example', '*.cdn.example'],
        },
      ],
    }),
  )
  const catalog = async () =>
    (await (await f.call('/_speaker/catalog', { headers: bearer(agent.token) })).json()) as {
      extensions: Record<string, object>
      mcp: Record<string, object>
      text: string
    }
  for (let i = 0; i < 100 && !Object.keys((await catalog()).extensions).length; i++) await sleep(20)
  const listed = await catalog()
  assert.deepEqual(listed.extensions.web, {
    label: 'Web search',
    description: 'Search the web',
    tools: ['web_search'],
    sites: ['search.example', '*.cdn.example'],
    state: 'ask',
  })
  assert.deepEqual(listed.mcp.files, { label: 'Files', tools: ['read_file'], state: 'ask' })
  assert.match(listed.text, /^- site:<any hostname> — any website; ask for the exact hostname\.$/m)
  assert.match(listed.text, /^- ext:web — Web search: Search the web/m)
  assert.doesNotMatch(listed.text, /\/me\b|curl/)
  const refused = async (want: string[]) => {
    const response = await askFor(f, agent.token, { want, reason: 'x' })
    assert.equal(response.status, 400)
    return ((await response.json()) as { message: string }).message
  }
  assert.equal(
    await refused(['ext:nope']),
    'ext:nope is not something you can ask for. Extensions you can ask for: web.',
  )
  assert.match(await refused(['mcp:nope']), /MCP servers you can ask for: files\./)

  const made = (await (await askFor(f, agent.token, { want: ['ext:web'], reason: 'search' })).json()) as Outcome
  const [card] = await f.pending()
  for (const item of ['ext:web', 'site:search.example', 'site:*.cdn.example'])
    assert.ok(card.html.includes(`value="${item}"`), `the card lists ${item}`)
  assert.equal((await f.decide(made.id, 'approve')).status, 303)
  assert.deepEqual((await f.grants()).map((g) => g.item).sort(), [
    'ext:web',
    'site:*.cdn.example',
    'site:search.example',
  ])
  // Closing the host's connection clears what it reported.
  ws.close()
  for (let i = 0; i < 100 && Object.keys((await catalog()).extensions).length; i++) await sleep(20)
  assert.deepEqual((await catalog()).extensions, {})
})

// A host reporting one extension (`web`) that needs two sites, and an agent on it.
async function hostWithExtension(f: Fixture, t: TestContext) {
  const { agent } = await approvedHost(f, ['site', 'ext'])
  const ws = new WebSocket(`${f.url.replace('http', 'ws')}/_speaker/hosts/ws`, {
    headers: { authorization: 'Bearer host-token' },
  })
  t.after(() => ws.terminate())
  await once(ws, 'open')
  const extension = { id: 'web', label: 'Web', description: 'Search', tools: ['s'], sites: ['a.example', 'b.example'] }
  ws.send(JSON.stringify({ type: 'catalog', mcps: [], extensions: [extension] }))
  const listed = async () =>
    Object.keys(
      (
        (await (await f.call('/_speaker/catalog', { headers: bearer(agent.token) })).json()) as {
          extensions: Record<string, object>
        }
      ).extensions,
    )
  for (let i = 0; i < 100 && !(await listed()).length; i++) await sleep(20)
  const approve = async (want: string[]) => {
    const made = (await (await askFor(f, agent.token, { want, reason: 'r', duration: '30m' })).json()) as Outcome
    assert.equal((await f.decide(made.id, 'approve', { duration: '30m' })).status, 303)
  }
  const held = async () => (await f.grants()).map((g) => g.item).sort()
  return { agent, approve, held }
}

test('an extension’s sites end with it: revoking ext ends the sites it brought, never one asked for itself', async (t) => {
  const f = await setup(t)
  const h = await hostWithExtension(f, t)
  await h.approve(['ext:web', 'site:b.example'])
  assert.deepEqual(await h.held(), ['ext:web', 'site:a.example', 'site:b.example'])
  assert.match((await f.live()).grants, /comes with ext:web/)
  const ext = (await f.grants()).find((g) => g.item === 'ext:web')
  assert.ok(ext)
  assert.equal((await f.ownerForm('/grants/revoke', { id: ext.id })).status, 303)
  // b.example was asked for explicitly, so it stays; a.example was only the extension's.
  assert.deepEqual(await h.held(), ['site:b.example'])
})

test('a site the agent already holds on its own stays when the extension ends, and revoking the agent ends everything', async (t) => {
  const f = await setup(t)
  const h = await hostWithExtension(f, t)
  await h.approve(['site:a.example'])
  await h.approve(['ext:web'])
  assert.deepEqual(await h.held(), ['ext:web', 'site:a.example', 'site:b.example'])
  const ext = (await f.grants()).find((g) => g.item === 'ext:web')
  assert.ok(ext)
  await f.ownerForm('/grants/revoke', { id: ext.id })
  assert.deepEqual(await h.held(), ['site:a.example'])
  await h.approve(['ext:web'])
  assert.equal((await f.ownerForm(`/agents/${h.agent.id}/revoke`, {})).status, 303)
  assert.deepEqual(await h.held(), [])
})

test('an extension’s sites expire with it', async (t) => {
  const f = await setup(t)
  const h = await hostWithExtension(f, t)
  await h.approve(['ext:web'])
  assert.equal((await h.held()).length, 3)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31 * 60_000 })
  assert.deepEqual(await h.held(), [])
})

test('approving a host that registers again from the same address and name replaces the old one and its agents', async (t) => {
  const f = await setup(t)
  const first = await approvedHost(f)
  const register = async (name: string, token: string) =>
    (
      (await (
        await f.call('/_speaker/hosts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, kinds: ['site'], tokenHash: sha(token) }),
        })
      ).json()) as { id: string }
    ).id
  const other = await register('elsewhere', 'other-token')
  assert.equal((await f.ownerForm(`/hosts/${other}/approve`, {})).status, 303)
  const again = await register('test', 'host-token-2')
  // Registration alone changes nothing; the card says what approval will do.
  assert.match((await f.live()).approvals, /Approving replaces the approved host test registered/)
  assert.match((await f.live()).grants, /Sandbox host test/)
  assert.equal((await f.ownerForm(`/hosts/${again}/approve`, {})).status, 303)
  const active = (await f.live()).grants
  assert.equal(active.match(/Sandbox host test/g)?.length, 1)
  assert.match(active, /Sandbox host elsewhere/)
  assert.match(active, /registered <time/)
  assert.equal((await f.call('/_speaker/catalog', { headers: bearer(first.agent.token) })).status, 403)
  assert.equal((await f.ownerForm(`/hosts/${first.id}/remove`, {})).status, 404)
})

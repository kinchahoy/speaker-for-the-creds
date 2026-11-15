import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import {
  Agent,
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { connect, getCACertificates, setDefaultCACertificates } from 'node:tls'
import { serve } from '@hono/node-server'
import 'reflect-metadata'
import * as x509 from '@peculiar/x509'
import { WebSocketServer } from 'ws'
import { covers } from '../items.ts'
import { createApp, readConfig } from '../server.ts'
import { setOwnerPassword } from './owner.ts'

const realToken = 'ghp_real_token_only_github_should_see'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const port = (server: { address(): string | AddressInfo | null }) => (server.address() as AddressInfo).port
const freePort = async () => {
  const probe = createNetServer().listen(0)
  await once(probe, 'listening')
  const free = port(probe)
  probe.close()
  await once(probe, 'close')
  return free
}

// A self-signed certificate for localhost: the local HTTPS upstream, which speaker is made to trust.
async function selfSigned() {
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
  const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=localhost',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3600_000),
    signingAlgorithm: algorithm,
    keys,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'localhost' }])],
  })
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')
  return { cert: cert.toString('pem'), key: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n` }
}

// Speaker trusts the test upstream's self-signed certificate like any public one.
const identity = await selfSigned()
setDefaultCACertificates([...getCACertificates('default'), identity.cert])

type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }

async function setup(t: TestContext) {
  const seen: Seen[] = []
  const upstream = createHttpsServer(identity, async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ method: req.method, url: req.url, headers: req.headers, body })
    res.setHeader('content-type', 'application/json').end('{"upstream":true}')
  }).listen(0)
  await once(upstream, 'listening')

  const keyless: Seen[] = []
  const keylessUpstream = createHttpServer((req, res) => {
    keyless.push({ method: req.method, url: req.url, headers: req.headers, body: '' })
    res.setHeader('content-type', 'application/json').end('{"keyless":true}')
  }).listen(0, '127.0.0.1')
  await once(keylessUpstream, 'listening')

  const dataDir = await mkdtemp(join(tmpdir(), 'speaker-secrets-'))
  const proxyPort = await freePort()
  const sshPort = await freePort()
  const app = await createApp(
    readConfig({
      DATA_DIR: dataDir,
      PUBLIC_URL: 'http://localhost',
      PROXY_PORT: String(proxyPort),
      SSH_PORT: String(sshPort),
    }),
  )
  const server = serve({
    fetch: app.fetch,
    port: 0,
    hostname: '127.0.0.1',
    websocket: { server: new WebSocketServer({ noServer: true }) },
  }) as Server
  await once(server, 'listening')
  const url = `http://127.0.0.1:${port(server)}`
  t.after(async () => {
    await app.stop()
    app.proxy.closeAllConnections()
    app.proxy.close()
    server.closeAllConnections()
    server.close()
    upstream.closeAllConnections()
    upstream.close()
    keylessUpstream.closeAllConnections()
    keylessUpstream.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const call = (path: string, init: RequestInit = {}) => fetch(url + path, { redirect: 'manual', ...init })
  const cookie = await setOwnerPassword(call)
  const owner = { cookie, origin: 'http://localhost' }
  const ownerForm = async (path: string, body: Record<string, string>) => {
    const response = await call(`/admin${path}`, { method: 'POST', headers: owner, body: new URLSearchParams(body) })
    assert.equal(response.status, 303, `${path} answered ${response.status}`)
  }
  await ownerForm('/secrets/save', { name: 'GITHUB_TOKEN', value: realToken, hosts: 'localhost', env: 'GH_TOKEN' })
  await ownerForm('/services/save', {
    id: 'weather',
    baseUrl: `http://127.0.0.1:${port(keylessUpstream)}/api`,
    authType: 'none',
    read: 'ask',
    write: 'ask',
  })

  // A direct agent: enrolls with its token, asks for items, and the owner approves what its card shows.
  async function agent(name: string) {
    const token = `${name}-token-${Math.random().toString(16).slice(2)}`
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const enrolled = await call('/_speaker/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: name, agent: 'Test LLM · Test app', tokenHash: sha(token), want: [] }),
    })
    assert.equal(enrolled.status, 201)
    const ask = async (want: string[]) => {
      const reply = await call('/_speaker/requests', {
        method: 'POST',
        headers,
        body: JSON.stringify({ want, reason: 'test', duration: '1h' }),
      })
      assert.equal(reply.status, 202, await reply.clone().text())
      const { id } = (await reply.json()) as { id: string }
      const inbox = await (await call('/admin/panel/inbox', { headers: owner })).text()
      const card = inbox.split('<article id="request-').find((c) => c.startsWith(id)) ?? ''
      const body = new URLSearchParams({ duration: '1h' })
      for (const [, item] of card.matchAll(/name="shown" type="hidden" value="([^"]*)"/g)) {
        body.append('items', item)
        body.append('shown', item)
      }
      await call(`/admin/requests/${id}/approve`, { method: 'POST', headers: owner, body })
      return card
    }
    const me = async () => (await (await call('/_speaker/catalog', { headers })).json()) as Me
    return { token, headers, ask, me }
  }
  const grantIds = async () =>
    [...(await (await call('/admin/panel/active', { headers: owner })).text()).matchAll(/<li id="grant-([^"]+)"/g)].map(
      (m) => m[1],
    )
  const revokeAll = async () => {
    for (const id of await grantIds()) await ownerForm('/grants/revoke', { id })
  }
  return { call, proxyPort, sshPort, seen, keyless, agent, revokeAll, ownerForm, upstreamPort: port(upstream) }
}
type Me = {
  secrets: Record<
    string,
    {
      hosts: string[]
      state: string
      placeholder?: string
      environment: Record<string, string>
      certificate: string
      git: string
      note: string
    }
  >
}

type Reply = { status: number; text: string }
type Request = { method?: string; path?: string; headers?: Record<string, string>; body?: string }
// An HTTPS tunnel through speaker's proxy: CONNECT with Basic credentials, then TLS trusting speaker's certificate.
// A refusal comes back as the reply instead of a tunnel.
async function open(
  proxyPort: number,
  ca: string,
  target: { host: string; port: number },
  proxyAuth?: string,
): Promise<{ refused: Reply } | { send(request?: Request): Promise<Reply>; close(): void }> {
  const connecting = httpRequest({
    port: proxyPort,
    host: '127.0.0.1',
    method: 'CONNECT',
    path: `${target.host}:${target.port}`,
    headers: proxyAuth
      ? { 'proxy-authorization': `Basic ${Buffer.from(`agent:${proxyAuth}`).toString('base64')}` }
      : {},
  }).end()
  // Node reports every answer to CONNECT as `connect`; anything but 200 is a refusal with its message as the body.
  const [answer, socket, head] = await once(connecting, 'connect')
  if (answer.statusCode !== 200) {
    let text = head.toString()
    for await (const chunk of socket) text += chunk
    return { refused: { status: answer.statusCode, text } }
  }
  const tls = connect({ socket, servername: target.host, ca })
  const agent = new Agent({ keepAlive: true })
  agent.createConnection = () => tls
  return {
    close: () => tls.destroy(),
    async send({ method = 'GET', path = '/', headers = {}, body } = {}) {
      const sent = httpRequest({
        agent,
        host: target.host,
        port: target.port,
        method,
        path,
        headers: { ...headers, ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}) },
      })
      sent.end(body)
      const [res] = await once(sent, 'response')
      let text = ''
      for await (const chunk of res) text += chunk
      return { status: res.statusCode, text }
    },
  }
}
// One request per tunnel, or the refusal.
async function through(
  proxyPort: number,
  ca: string,
  target: { host: string; port: number },
  proxyAuth?: string,
  requests: Request[] = [],
) {
  const tunnel = await open(proxyPort, ca, target, proxyAuth)
  if ('refused' in tunnel) return [tunnel.refused]
  const replies: Reply[] = []
  for (const request of requests) replies.push(await tunnel.send(request))
  tunnel.close()
  return replies
}

test("registering a sandbox host tells it speaker's proxy and SSH ports", async (t) => {
  const s = await setup(t)
  const reply = await s.call('/_speaker/hosts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test', kinds: ['secret'], tokenHash: sha('host-token') }),
  })
  assert.equal(reply.status, 201)
  const { id, ...rest } = (await reply.json()) as { id: string }
  assert.ok(id)
  assert.deepEqual(rest, { status: 'pending', proxyPort: s.proxyPort, sshPort: s.sshPort })
})

test('the catalog lists every secret to a direct agent, and an unknown secret is refused', async (t) => {
  const s = await setup(t)
  const agent = await s.agent('lister')
  const before = (await (await s.call('/_speaker/catalog', { headers: agent.headers })).json()) as {
    secrets: Record<string, object>
    text: string
  }
  assert.deepEqual(before.secrets, { GITHUB_TOKEN: { hosts: ['localhost'], env: 'GH_TOKEN', state: 'ask' } })
  assert.match(before.text, /^- secret:GITHUB_TOKEN — for localhost \(set GH_TOKEN\)\. Not granted\.$/m)
  assert.match(before.text, /^- folder:<share> and ssh:<target> — names are not listed;/m)
  assert.doesNotMatch(before.text, /site:<any hostname>|\/me\b|curl/)
  const refused = await s.call('/_speaker/requests', {
    method: 'POST',
    headers: agent.headers,
    body: JSON.stringify({ want: ['secret:NOPE'], reason: 'x' }),
  })
  assert.equal(refused.status, 400)
  assert.equal(
    ((await refused.json()) as { message: string }).message,
    'secret:NOPE is not something you can ask for. Secrets you can ask for: GITHUB_TOKEN.',
  )
  await agent.ask(['secret:GITHUB_TOKEN'])
  const after = (await agent.me()).secrets.GITHUB_TOKEN
  assert.equal(after.state, 'granted')
  assert.match(after.placeholder ?? '', /^speaker-placeholder-/)
})

test('placeholders become the real secret for covered hosts only, in Bearer and Basic credentials', async (t) => {
  const s = await setup(t)
  const agent = await s.agent('gh')
  const card = await agent.ask(['secret:GITHUB_TOKEN'])
  // The card shows where the value goes, in the tint of the other items that can change things.
  assert.match(
    card,
    /<label class="risky"><input type="checkbox" name="items" value="secret:GITHUB_TOKEN"[\s\S]*sent to localhost/,
  )

  const { secrets } = await agent.me()
  const grant = secrets.GITHUB_TOKEN
  const placeholder = grant.environment.GH_TOKEN
  assert.match(placeholder, /^speaker-placeholder-[0-9a-f]{48}$/)
  assert.deepEqual(grant.hosts, ['localhost'])
  assert.equal(grant.environment.HTTPS_PROXY, `http://agent:<token>@127.0.0.1:${s.proxyPort}`)
  assert.match(grant.environment.SSL_CERT_FILE, /ca\.pem$/)
  assert.match(grant.certificate, /_speaker\/proxy\/ca\.pem.*GIT_SSL_CAINFO.*http\.sslCAInfo/)
  // The gh/git hint is only for secrets bound to GitHub hosts; this one goes to localhost.
  assert.equal(grant.git, undefined)
  // The same placeholder every time, and the real value nowhere in what the agent sees.
  assert.equal((await agent.me()).secrets.GITHUB_TOKEN.environment.GH_TOKEN, placeholder)
  assert.ok(!JSON.stringify(grant).includes(realToken))

  const ca = await (await s.call('/_speaker/proxy/ca.pem')).text()
  assert.match(ca, /^-----BEGIN CERTIFICATE-----/)
  const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString('base64')}`
  const replies = await through(s.proxyPort, ca, { host: 'localhost', port: s.upstreamPort }, agent.token, [
    {
      method: 'POST',
      path: '/repos/o/r/pulls?q=1',
      headers: { authorization: `token ${placeholder}`, 'x-other': placeholder },
      body: `{"body":"${placeholder}"}`,
    },
    { headers: { authorization: `Bearer ${placeholder}` } },
    { headers: { authorization: basic(`x-access-token:${placeholder}`) } },
  ])
  assert.deepEqual(
    replies.map((r) => [r.status, r.text]),
    Array(3).fill([200, '{"upstream":true}']),
  )
  assert.equal(s.seen[0].headers.authorization, `token ${realToken}`)
  assert.equal(s.seen[1].headers.authorization, `Bearer ${realToken}`)
  assert.equal(s.seen[2].headers.authorization, basic(`x-access-token:${realToken}`))
  assert.equal(s.seen[0].url, '/repos/o/r/pulls?q=1')
  // Only the Authorization header is rewritten: other headers and bodies pass as sent.
  assert.equal(s.seen[0].headers['x-other'], placeholder)
  assert.equal(s.seen[0].body, `{"body":"${placeholder}"}`)
  assert.equal(s.seen[0].headers['proxy-authorization'], undefined)
  assert.equal(s.seen[0].headers.host, `localhost:${s.upstreamPort}`)
})

test('the proxy refuses hosts no secret grant covers, agents without the grant, and bad credentials', async (t) => {
  const s = await setup(t)
  const holder = await s.agent('holder')
  await holder.ask(['secret:GITHUB_TOKEN'])
  const other = await s.agent('other')
  const ca = await (await s.call('/_speaker/proxy/ca.pem')).text()
  const target = { host: 'localhost', port: s.upstreamPort }

  const elsewhere = await through(s.proxyPort, ca, { host: 'example.org', port: 443 }, holder.token, [])
  assert.equal(elsewhere[0].status, 403)
  assert.match(
    elsewhere[0].text,
    /^speaker: no secret grant of yours covers example\.org; speaker is not a general proxy.*\n$/,
  )
  const ungranted = await through(s.proxyPort, ca, target, other.token, [])
  assert.equal(ungranted[0].status, 403)
  assert.equal((await through(s.proxyPort, ca, target, 'not-a-token', []))[0].status, 407)
  assert.equal((await through(s.proxyPort, ca, target, undefined, []))[0].status, 407)
  assert.deepEqual(s.seen, [])

  assert.ok(covers('*.example.org', 'api.example.org'))
  assert.ok(!covers('*.example.org', 'example.org'))
  assert.ok(covers('Github.com', 'github.COM'))
  assert.ok(!covers('github.com', 'api.github.com'))
})

test('revoking the grant stops the proxy at once, inside an open tunnel and for new ones', async (t) => {
  const s = await setup(t)
  const agent = await s.agent('gh')
  await agent.ask(['secret:GITHUB_TOKEN'])
  const placeholder = (await agent.me()).secrets.GITHUB_TOKEN.environment.GH_TOKEN
  const ca = await (await s.call('/_speaker/proxy/ca.pem')).text()
  const target = { host: 'localhost', port: s.upstreamPort }
  const request = { headers: { authorization: `Bearer ${placeholder}` } }

  // One tunnel, two requests, the grant revoked between them.
  const tunnel = await open(s.proxyPort, ca, target, agent.token)
  assert.ok('send' in tunnel)
  assert.equal((await tunnel.send(request)).status, 200)
  await s.revokeAll()
  const ended = await tunnel.send(request)
  assert.equal(ended.status, 403)
  assert.match(ended.text, /access to localhost ended/)
  tunnel.close()
  assert.equal(s.seen.length, 1)
  assert.equal((await through(s.proxyPort, ca, target, agent.token, [request]))[0].status, 403)
  assert.equal(s.seen.length, 1)
})

test('adding a host to a secret ends the grants already given for it; removing a host keeps them', async (t) => {
  const s = await setup(t)
  const agent = await s.agent('widen')
  await agent.ask(['secret:GITHUB_TOKEN'])
  assert.equal((await agent.me()).secrets.GITHUB_TOKEN.state, 'granted')
  const save = (hosts: string) =>
    s.ownerForm('/secrets/save', { name: 'GITHUB_TOKEN', value: '', hosts, env: 'GH_TOKEN' })
  await save('localhost api.test')
  assert.equal((await agent.me()).secrets.GITHUB_TOKEN.state, 'ask')
  await agent.ask(['secret:GITHUB_TOKEN'])
  await save('localhost')
  assert.equal((await agent.me()).secrets.GITHUB_TOKEN.state, 'granted')
})

test('deleting a secret ends its grants and drops pending requests for it', async (t) => {
  const s = await setup(t)
  const holder = await s.agent('holder')
  await holder.ask(['secret:GITHUB_TOKEN'])
  const waiter = await s.agent('waiter')
  const filed = await s.call('/_speaker/requests', {
    method: 'POST',
    headers: waiter.headers,
    body: JSON.stringify({ want: ['secret:GITHUB_TOKEN'], reason: 'later' }),
  })
  const { id } = (await filed.json()) as { id: string }
  await s.ownerForm('/secrets/delete', { name: 'GITHUB_TOKEN' })
  const grants = async () => ((await holder.me()) as unknown as { grants: { item: string }[] }).grants
  assert.deepEqual(await grants(), [])
  const outcome = await (await s.call(`/_speaker/requests/${id}`, { headers: waiter.headers })).json()
  assert.deepEqual([outcome.status, outcome.denied], ['decided', ['secret:GITHUB_TOKEN']])
})

test('a keyless service forwards calls without any credential', async (t) => {
  const s = await setup(t)
  const agent = await s.agent('reader')
  await agent.ask(['weather.read'])
  const reply = await s.call('/weather/today?city=x', { headers: agent.headers })
  assert.equal(reply.status, 200)
  assert.deepEqual(await reply.json(), { keyless: true })
  assert.equal(s.keyless[0].url, '/api/today?city=x')
  assert.equal(s.keyless[0].headers.authorization, undefined)
  // The service is listed with its state like any other.
  const me = (await (await s.call('/_speaker/catalog', { headers: agent.headers })).json()) as { services: object }
  assert.ok('weather' in me.services)
})

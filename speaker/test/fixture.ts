import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createSocket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { serve } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { createApp, readConfig } from '../server.ts'

export const ownerPassword = 'owner-password-for-tests'
export const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export const freePort = async () => {
  const probe = createSocket().listen(0)
  await once(probe, 'listening')
  const { port } = probe.address() as AddressInfo
  probe.close()
  await once(probe, 'close')
  return port
}

export type Fixture = Awaited<ReturnType<typeof start>>

// Speaker in-process on a temp data folder (pass `dir` to restart on an existing one), a fake upstream that records
// what reaches it, and the owner and agent roles speaking HTTP the way the pages and agents do.
export async function start(t: TestContext, { dir, env = {} }: { dir?: string; env?: Record<string, string> } = {}) {
  const restarted = dir !== undefined
  const dataDir = dir ?? (await mkdtemp(join(tmpdir(), 'speaker-test-')))
  if (!restarted) {
    await copyFile(new URL('../config.example.json', import.meta.url), join(dataDir, 'config.json'))
  }
  const seen: { url?: string; headers: Record<string, unknown> }[] = []
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    res.statusCode = req.url?.endsWith('/missing') ? 404 : 200
    res.setHeader('content-type', 'application/json').end('{"ok":true}')
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  const proxyPort = await freePort()
  const app = await createApp(
    readConfig({
      DATA_DIR: dataDir,
      PUBLIC_URL: 'http://localhost',
      PROXY_PORT: String(proxyPort),
      SSH_PORT: String(await freePort()),
      ...env,
    }),
  )
  const server = serve({
    fetch: app.fetch,
    port: 0,
    hostname: '127.0.0.1',
    websocket: { server: new WebSocketServer({ noServer: true }) },
  }) as Server
  await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  t.after(async () => {
    await app.stop()
    for (const s of [app.proxy, server, upstream]) {
      s.closeAllConnections()
      s.close()
    }
    if (!restarted) await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
  })
  const call = (path: string, init: RequestInit = {}) => fetch(url + path, { redirect: 'manual', ...init })
  const json = (body: object, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

  // The owner: a session cookie for the form routes the page posts to, a bearer token for the JSON lists.
  let cookie = ''
  let token = ''
  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    call(path, { method: 'POST', headers: { origin: 'http://localhost', ...headers }, body: new URLSearchParams(body) })
  const signIn = async (path = '/admin/signin') => {
    const response = await post(path, { password: ownerPassword, confirm: ownerPassword })
    assert.equal(response.status, 303)
    cookie = response.headers.getSetCookie()[0].split(';')[0]
  }
  const form = (path: string, body: Record<string, string | string[]>) =>
    call(`/admin${path}`, {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost' },
      body: new URLSearchParams(
        Object.entries(body).flatMap(([k, v]) => [v].flat().map((x): [string, string] => [k, x])),
      ),
    })
  const api = async (path: string) => {
    if (!token) {
      const signed = await call('/admin/api/signin', json({ password: ownerPassword }))
      token = ((await signed.json()) as { token: string }).token
    }
    return (await call(`/admin/api${path}`, { headers: { authorization: `Bearer ${token}` } })).json()
  }
  type Card = { id: string; as?: string; items: { item: string; wider?: boolean }[] }
  const cards = async () => ((await api('/pending')) as { pending: Card[] }).pending
  const grants = async () => ((await api('/active')) as { grants: { id: string; item: string }[] }).grants
  // Taps Approve (all items the card shows, or only `only`) or Deny on a card.
  const decide = async (id: string, decision: 'approve' | 'deny', only?: string[]) => {
    const shown = (await cards()).find((c) => c.id === id)?.items.map((i) => i.item) ?? []
    const response = await form(`/requests/${id}/${decision}`, {
      duration: '1h',
      items: decision === 'deny' ? [] : (only ?? shown),
      shown,
    })
    assert.equal(response.status, 303)
  }
  const revoke = async (item: string) => {
    const grant = (await grants()).find((g) => g.item === item)
    assert.ok(grant, `${item} is granted`)
    assert.equal((await form('/grants/revoke', { id: grant.id })).status, 303)
  }
  const audit = async () =>
    (await readFile(join(dataDir, 'audit.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  const saveService = (id: string, fields: Record<string, string> = {}) =>
    form('/services/save', {
      id,
      baseUrl: `${upstreamUrl}/base`,
      authType: 'bearer',
      read: 'ask',
      write: 'ask',
      ...fields,
    })

  // A direct agent: enrols with its token's hash, asks, and calls through the proxy.
  const enrol = async (name = 'agent', headers: Record<string, string> = {}, extra: object = {}) => {
    const secret = `${name}-${randomUUID()}`
    const bearer = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }
    const enrolled = await call(
      '/_speaker/agents',
      json({ label: name, agent: 'Test LLM · Test app on test', tokenHash: sha(secret), ...extra }, headers),
    )
    assert.equal(enrolled.status, 201)
    const { id } = (await enrolled.json()) as { id: string }
    const as = (path: string, init: RequestInit = {}, more: Record<string, string> = {}) =>
      call(path, { ...init, headers: { ...bearer, ...more } })
    const ask = async (want: string[]) => {
      const reply = await as('/_speaker/requests', json({ want, reason: 'test', duration: '1h' }))
      assert.equal(reply.status, 202)
      return ((await reply.json()) as { id: string }).id
    }
    const catalog = async () => (await as('/_speaker/catalog')).json() as Promise<Record<string, any>>
    return { id, token: secret, as, ask, catalog }
  }
  if (!restarted) await signIn('/admin/setup')
  return {
    proxyPort,
    url,
    cookie: () => cookie,
    dir: dataDir,
    upstreamUrl,
    seen,
    call,
    json,
    post,
    signIn,
    form,
    api,
    cards,
    grants,
    decide,
    revoke,
    audit,
    saveService,
    enrol,
  }
}

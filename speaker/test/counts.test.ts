import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp, readConfig } from '../server.ts'
import { freePorts, quiet, setOwnerPassword } from './owner.ts'

test("the admin page counts an agent's refused requests, blocked calls and granted items", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'speaker-counts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = quiet(
    await createApp(readConfig({ DATA_DIR: dir, PUBLIC_URL: 'http://localhost', ...(await freePorts()) })),
  )
  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init }))
  const cookie = await setOwnerPassword(call)
  const token = 'counted-agent'
  const bearer = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const enrolled = await call('/_speaker/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'counted',
      agent: 'Test LLM · Test app',
      tokenHash: createHash('sha256').update(token).digest('hex'),
    }),
  })
  assert.equal(enrolled.status, 201)

  // Refused before the owner saw it: a name that does not exist.
  const refused = await call('/_speaker/requests', {
    method: 'POST',
    headers: bearer,
    body: JSON.stringify({ want: ['nosuch.read'] }),
  })
  assert.equal(refused.status, 400)
  // Blocked: a write without a grant; the call files a card.
  const blocked = await call('/demo/x', { method: 'POST', headers: bearer })
  assert.equal(blocked.status, 403)
  const { request } = (await blocked.json()) as { request: string }
  // Granted: the owner approves that card.
  const approved = await call(`/admin/requests/${request}/approve`, {
    method: 'POST',
    headers: { origin: 'http://localhost', cookie },
    body: new URLSearchParams({ duration: '30m', items: 'demo.full', shown: 'demo.full' }),
  })
  assert.equal(approved.status, 303)

  const page = await (await call('/admin?section=active', { headers: { cookie } })).text()
  assert.match(
    page,
    /<small title="[^"]*">1 request · 1 granted · 0 denied · <span class="warn">1 refused<\/span> · <span class="warn">1 blocked<\/span><\/small>/,
  )
  assert.match(page, /title="[^"]*no grant for demo\.full/)
})

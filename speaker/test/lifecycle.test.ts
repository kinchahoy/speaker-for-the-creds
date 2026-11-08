import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  IllegalTransition,
  identityStates,
  identityTable,
  type RequestEvent,
  requestStates,
  requestTable,
  transition,
} from '../lifecycle.ts'
import { createApp, readConfig } from '../server.ts'

test('every table target is a known state and terminal states accept no event', () => {
  for (const [states, table] of [
    [requestStates, requestTable],
    [identityStates, identityTable],
  ] as const) {
    assert.deepEqual(Object.keys(table).sort(), [...states].sort())
    for (const moves of Object.values(table))
      for (const to of Object.values(moves)) assert.ok((states as readonly string[]).includes(to as string))
  }
  for (const state of ['denied', 'expired', 'revoked', 'superseded'] as const) assert.deepEqual(requestTable[state], {})
})

test('request transitions: legal moves land on the table state, illegal moves throw', () => {
  assert.equal(transition('request', requestTable, 'pending', 'approve'), 'approved')
  assert.equal(transition('request', requestTable, 'pending', 'expire'), 'expired')
  assert.equal(transition('request', requestTable, 'approved', 'revoke'), 'revoked')
  assert.equal(transition('request', requestTable, 'approved', 'supersede'), 'superseded')
  const illegal: [(typeof requestStates)[number], RequestEvent][] = [
    ['approved', 'approve'],
    ['approved', 'deny'],
    ['denied', 'approve'],
    ['expired', 'approve'],
    ['pending', 'revoke'],
    ['revoked', 'expire'],
  ]
  for (const [from, event] of illegal)
    assert.throws(() => transition('request', requestTable, from, event), IllegalTransition, `${from} + ${event}`)
  assert.equal(transition('session', identityTable, 'approved', 'expire'), 'expired')
  assert.throws(() => transition('session', identityTable, 'denied', 'approve'), IllegalTransition)
  assert.throws(() => transition('enforcer', identityTable, 'pending', 'expire'), IllegalTransition)
})

test('PUBLIC_URL is required', () => {
  assert.throws(() => readConfig({ ADMIN_PASSWORD: 'pw' }), /PUBLIC_URL/)
})

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const owner = { authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}`, origin: 'http://localhost' }

async function setup(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'speaker-lifecycle-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const app = await createApp(readConfig({ ADMIN_PASSWORD: 'pw', DATA_DIR: dataDir, PUBLIC_URL: 'http://localhost' }))
  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init }))
  const json = (path: string, body: object, headers: Record<string, string>) =>
    call(path, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const enroll = async (token: string) => {
    const response = await json(
      '/_speaker/sessions',
      { label: 's', llmName: 'Test LLM', tokenHash: sha(token), duration: '1h' },
      {},
    )
    return { response, id: response.status === 201 ? ((await response.json()) as { id: string }).id : '' }
  }
  const approveSession = (id: string) =>
    call(`/admin/sessions/${id}/approve`, {
      method: 'POST',
      headers: owner,
      body: new URLSearchParams({ duration: '1h' }),
    })
  return { call, json, enroll, approveSession }
}

test('requests and sessions store revoked, superseded and repeated decisions explicitly', async (t) => {
  const f = await setup(t)
  const { id } = await f.enroll('tok')
  assert.equal((await f.approveSession(id)).status, 303)
  assert.equal((await f.approveSession(id)).status, 409)
  const agent = { authorization: 'Bearer tok' }
  const request = async () =>
    (
      (await (
        await f.json(
          '/_speaker/requests',
          { capability: { kind: 'credential', ref: 'demo.write' }, reason: 'r', duration: '15m' },
          agent,
        )
      ).json()) as { id: string }
    ).id
  const status = async (requestId: string) =>
    ((await (await f.call(`/_speaker/requests/${requestId}`, { headers: agent })).json()) as { status: string }).status
  const decide = (requestId: string, decision: 'approve' | 'deny') =>
    f.json(`/admin/api/requests/${requestId}/${decision}`, { duration: '1h' }, owner)

  const first = await request()
  assert.equal((await decide(first, 'approve')).status, 200)
  assert.equal(await status(first), 'approved')
  assert.equal((await decide(first, 'deny')).status, 409)

  const second = await request()
  await decide(second, 'approve')
  assert.equal(await status(first), 'superseded')

  const leases = (await (await f.call('/admin/api/leases', { headers: owner })).json()) as { id: string }[]
  await f.json(`/admin/api/leases/${leases[0].id}/revoke`, {}, owner)
  assert.equal(await status(second), 'revoked')

  const denied = { method: 'POST', headers: owner }
  assert.equal((await f.call(`/admin/sessions/${id}/deny`, denied)).status, 303)
  assert.equal((await f.call(`/admin/sessions/${id}/deny`, denied)).status, 409)
})

test('unauthenticated enrollment is rate limited', async (t) => {
  const f = await setup(t)
  for (let i = 0; i < 20; i++) assert.equal((await f.enroll(`t${i}`)).response.status, 201)
  assert.equal((await f.enroll('one-too-many')).response.status, 429)
})

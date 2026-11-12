import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  grantStates,
  grantTable,
  hostStates,
  hostTable,
  IllegalTransition,
  type RequestEvent,
  requestStates,
  requestTable,
  sessionTable,
  transition,
} from '../lifecycle.ts'
import { createApp, readConfig } from '../server.ts'
import { setOwnerPassword } from './owner.ts'

test('every table target is a known state and terminal states accept no event', () => {
  for (const [states, table] of [
    [requestStates, requestTable],
    [grantStates, grantTable],
    [hostStates, hostTable],
    [['connecting', 'open', 'closed'], sessionTable],
  ] as const) {
    assert.deepEqual(Object.keys(table).sort(), [...states].sort())
    for (const moves of Object.values(table))
      for (const to of Object.values(moves)) assert.ok((states as readonly string[]).includes(to as string))
  }
  for (const state of ['decided', 'expired'] as const) assert.deepEqual(requestTable[state], {})
  for (const state of ['expired', 'revoked'] as const) assert.deepEqual(grantTable[state], {})
})

test('transitions: legal moves land on the table state, illegal moves throw', () => {
  assert.equal(transition('request', requestTable, 'pending', 'decide'), 'decided')
  assert.equal(transition('request', requestTable, 'pending', 'expire'), 'expired')
  assert.equal(transition('grant', grantTable, 'active', 'revoke'), 'revoked')
  assert.equal(transition('grant', grantTable, 'active', 'expire'), 'expired')
  assert.equal(transition('host', hostTable, 'pending', 'approve'), 'approved')
  const illegal: [(typeof requestStates)[number], RequestEvent][] = [
    ['decided', 'decide'],
    ['decided', 'expire'],
    ['expired', 'decide'],
  ]
  for (const [from, event] of illegal)
    assert.throws(() => transition('request', requestTable, from, event), IllegalTransition, `${from} + ${event}`)
  assert.throws(() => transition('grant', grantTable, 'revoked', 'expire'), IllegalTransition)
  assert.throws(() => transition('host', hostTable, 'approved', 'approve'), IllegalTransition)
})

test('PUBLIC_URL is required', () => {
  assert.throws(() => readConfig({}), /PUBLIC_URL/)
})

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

async function setup(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'speaker-lifecycle-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const app = await createApp(readConfig({ DATA_DIR: dataDir, PUBLIC_URL: 'http://localhost' }))
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
      '/_speaker/agents',
      { label: 's', agent: 'Test LLM · Test app', tokenHash: sha(token) },
      {},
    )
    return { response, id: response.status === 201 ? ((await response.json()) as { id: string }).id : '' }
  }
  const owner = { cookie: await setOwnerPassword(call), origin: 'http://localhost' }
  return { call, json, enroll, owner }
}

test('requests, grants and agents move through explicit lifecycles, and repeated decisions are refused', async (t) => {
  const f = await setup(t)
  const owner = f.owner
  const { id } = await f.enroll('tok')
  const agent = { authorization: 'Bearer tok' }
  const ask = async () =>
    (
      (await (
        await f.json('/_speaker/requests', { want: ['demo.full'], reason: 'r', duration: '30m' }, agent)
      ).json()) as {
        id: string
      }
    ).id
  const me = async () =>
    (await (await f.call('/_speaker/me', { headers: agent })).json()) as {
      requests: { id: string; status: string; granted: string[] }[]
      grants: unknown[]
    }
  // The card posts the ticked items and every item it showed.
  const decide = (requestId: string, decision: 'approve' | 'deny') =>
    f.call(`/admin/requests/${requestId}/${decision}`, {
      method: 'POST',
      headers: owner,
      body: new URLSearchParams([
        ['duration', '1h'],
        ['items', 'demo.full'],
        ['shown', 'demo.full'],
      ]),
    })

  const first = await ask()
  assert.equal((await decide(first, 'approve')).status, 303)
  assert.deepEqual(
    (await me()).requests.map((r) => [r.status, r.granted]),
    [['decided', ['demo.full']]],
  )
  assert.equal((await decide(first, 'deny')).status, 409)

  // A later approval of the same item replaces the earlier grant.
  const second = await ask()
  await decide(second, 'approve')
  assert.equal((await me()).grants.length, 1)

  const active = await (await f.call('/admin/panel/active', { headers: owner })).text()
  const grantId = /<li id="grant-(\w+)"/.exec(active)?.[1] ?? ''
  assert.ok(grantId)
  // Local-time stamps the page script rewrites; request cards survive a panel refresh with the owner's choices.
  assert.match(active, /<time datetime="[^"]+" data-local data-left>/)
  await f.json('/_speaker/requests', { want: ['demo.full'], reason: 'r', duration: '30m' }, agent)
  assert.match(
    await (await f.call('/admin/panel/inbox', { headers: owner })).text(),
    /<article id="request-\w+" hx-preserve/,
  )
  await f.call('/admin/grants/revoke', { method: 'POST', headers: owner, body: new URLSearchParams({ id: grantId }) })
  assert.equal((await me()).grants.length, 0)

  const revoke = { method: 'POST', headers: owner }
  assert.equal((await f.call(`/admin/agents/${id}/revoke`, revoke)).status, 303)
  assert.equal((await f.call(`/admin/agents/${id}/revoke`, revoke)).status, 404)
})

test('unauthenticated enrollment is rate limited', async (t) => {
  const f = await setup(t)
  for (let i = 0; i < 20; i++) assert.equal((await f.enroll(`t${i}`)).response.status, 201)
  assert.equal((await f.enroll('one-too-many')).response.status, 429)
})

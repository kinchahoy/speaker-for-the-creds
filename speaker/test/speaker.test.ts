import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { type Fixture, freePort, ownerPassword, sha, start } from './fixture.ts'

const KEY = 'secret-only-the-upstream-should-see'
const body = async (response: Response) => (await response.json()) as Record<string, any>
const error = async (response: Response) => (await body(response)).error
const notes = async (t: TestContext) => {
  const f = await start(t)
  assert.equal((await f.saveService('notes', { secret: KEY })).status, 303)
  return f
}
// The agent asks for items, the owner approves exactly those, and the agent holds them.
const grant = async (f: Fixture, a: Awaited<ReturnType<Fixture['enrol']>>, ...want: string[]) =>
  f.decide(await a.ask(want), 'approve')

test('an approved agent reaches the upstream with the real key, never sees it, and a write needs .full', async (t) => {
  const f = await notes(t)
  const a = await f.enrol()
  const first = await a.as('/notes/things?q=1')
  assert.equal([first.status, await error(first)].join(), '403,approval_required')
  assert.equal(f.seen.length, 0)
  await f.decide((await body(await a.as('/notes/x'))).request, 'approve', ['notes.read'])
  const read = await a.as('/notes/things?q=1')
  assert.equal(read.status, 200)
  assert.deepEqual([f.seen[0].url, f.seen[0].headers.authorization], ['/base/things?q=1', `Bearer ${KEY}`])
  assert.ok(![...read.headers.values(), await read.text(), JSON.stringify(await a.catalog())].join().includes(KEY))
  const write = () => a.as('/notes/x', { method: 'PUT', body: '{}' })
  assert.equal(await error(await write()), 'approval_required')
  await grant(f, a, 'notes.full')
  assert.equal((await write()).status, 200)
})

test('a denied request keeps the call refused, and asking again does not get through', async (t) => {
  const f = await notes(t)
  const a = await f.enrol()
  await f.decide(await a.ask(['notes.read']), 'deny')
  await a.ask(['notes.read'])
  const refused = await a.as('/notes/x')
  assert.equal(refused.status, 403)
  assert.deepEqual(await f.grants(), [])
  assert.equal(f.seen.length, 0)
})

test('revoking a grant, expiry, and revoking the agent each stop calls at once', async (t) => {
  const f = await notes(t)
  const a = await f.enrol()
  const reads = async () => (await a.as('/notes/x')).status
  await grant(f, a, 'notes.read')
  assert.equal(await reads(), 200)
  await f.revoke('notes.read')
  assert.equal(await reads(), 403)

  await grant(f, a, 'notes.read')
  assert.equal(await reads(), 200)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61 * 60_000 })
  assert.equal(await reads(), 403)
  t.mock.timers.reset()

  await grant(f, a, 'notes.full')
  assert.equal(await reads(), 200)
  assert.equal((await f.form(`/agents/${a.id}/revoke`, {})).status, 303)
  assert.deepEqual(await f.grants(), [])
  const gone = await a.as('/notes/x')
  assert.equal([gone.status, await error(gone)].join(), '403,denied')
})

test('a scope uses its parent key inside its address, and fails closed when the parent moves or goes', async (t) => {
  const f = await start(t)
  const save = (id: string, baseUrl: string, more: Record<string, string> = {}) =>
    f.saveService(id, { baseUrl, read: 'never', write: 'never', ...more })
  assert.equal((await save('whole', `${f.upstreamUrl}/base`, { secret: 'whole-key' })).status, 303)
  assert.equal((await save('whole:part', `${f.upstreamUrl}/base/sub/one`, { read: 'open' })).status, 303)
  const a = await f.enrol()
  // The parent alone is closed to agents; the scope is one address, with the parent's key.
  assert.equal((await a.as('/whole/sub/one')).status, 403)
  assert.equal((await a.as('/whole:part')).status, 200)
  assert.deepEqual([f.seen[0].url, f.seen[0].headers.authorization], ['/base/sub/one', 'Bearer whole-key'])
  assert.equal((await a.as('/whole:part/x?q=1')).status, 200)
  assert.equal(f.seen[1].url, '/base/sub/one/x?q=1')
  // It cannot be pointed outside the parent's address, nor climb out of its own.
  assert.equal((await save('whole:out', `${f.upstreamUrl}/based`)).status, 400)
  assert.equal((await save('whole:away', 'http://127.0.0.1:1/base')).status, 400)
  const climb = await a.as('/whole:part/%2e%2e/%2e%2e/secret')
  assert.ok(climb.status >= 400 && f.seen.length === 2, `climbing out answered ${climb.status}`)
  await save('whole', `${f.upstreamUrl}/elsewhere`)
  assert.equal((await a.as('/whole:part')).status, 503)
  await save('whole', `${f.upstreamUrl}/base`, { secret: 'whole-key' })
  assert.equal((await a.as('/whole:part')).status, 200)
  assert.equal((await f.form('/services/delete', { id: 'whole' })).status, 303)
  assert.notEqual((await a.as('/whole:part')).status, 200)
})

test('a released secret is readable only while granted; an inserted one never; no value is logged or listed', async (t) => {
  const f = await start(t)
  const wifi = 'correct-horse-battery-staple'
  const inserted = 'inserted-secret-value'
  await f.form('/secrets/save', { name: 'wifi', value: wifi, release: 'on' })
  await f.form('/secrets/save', { name: 'GH_TOKEN', value: inserted, hosts: 'github.com', env: 'GH_TOKEN' })
  const a = await f.enrol()
  const read = async (name = 'wifi') => a.as(`/_speaker/secrets/${name}`)
  assert.equal((await read()).status, 403)
  await grant(f, a, 'secret:wifi')
  const ok = await read()
  assert.equal([ok.status, await ok.text()].join(), `200,${wifi}`)
  assert.equal((await read('GH_TOKEN')).status, 404)
  const seen = JSON.stringify([await a.catalog(), await f.audit(), await f.api('/active'), await f.api('/pending')])
  for (const value of [wifi, inserted]) assert.ok(!seen.includes(value))
  await f.revoke('secret:wifi')
  assert.equal((await read()).status, 403)
})

// A sandbox host registered from this machine and approved, with its channel open; `agent` lives on it.
async function sandbox(t: TestContext, f: Fixture, kinds = ['site']) {
  const bearer = { authorization: 'Bearer host-token', 'content-type': 'application/json' }
  const registered = await f.call('/_speaker/hosts', f.json({ name: 'box', kinds, tokenHash: sha('host-token') }))
  assert.equal((await f.form(`/hosts/${(await body(registered)).id}/approve`, {})).status, 303)
  const ws = new WebSocket(`${f.url.replace('http', 'ws')}/_speaker/hosts/ws`, { headers: bearer })
  t.after(() => ws.terminate())
  const snapshots: { grants: { item: string }[]; requests: unknown[] }[] = []
  ws.on('message', (data) => snapshots.push(JSON.parse(String(data))))
  await once(ws, 'open')
  const until = async <T>(look: () => T | Promise<T>) => {
    for (let i = 0; i < 200; i++) {
      const found = await look()
      if (found) return found
      await sleep(25)
    }
    throw new Error('timed out waiting for the host channel')
  }
  const made = await f.call('/_speaker/hosts/agents', {
    method: 'POST',
    headers: bearer,
    body: '{"label":"pi","agent":"Test LLM · Pi on box"}',
  })
  const agent = (await body(made)) as { id: string; token: string }
  const as = (path: string, init: RequestInit = {}) =>
    f.call(path, { ...init, headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' } })
  const ask = (want: string[]) =>
    f.call('/_speaker/requests', f.json({ agentId: agent.id, want, reason: 'test', duration: '1h' }, bearer))
  return { ws, snapshots, until, agent, as, ask }
}

test('a sandbox host: one card for site, extension and service; approval delivers the grants, revoking takes them away', async (t) => {
  const f = await notes(t)
  const h = await sandbox(t, f, ['site', 'ext'])
  const extension = { id: 'web', label: 'Web', description: 'Search', tools: ['s'], sites: ['a.example'] }
  h.ws.send(JSON.stringify({ type: 'catalog', mcps: [], extensions: [extension] }))
  await h.until(async () => Object.keys((await body(await h.as('/_speaker/catalog'))).extensions).length)
  assert.equal((await h.ask(['ext:web', 'site:b.example', 'notes.read'])).status, 202)
  const [card] = await h.until(async () => {
    const found = await f.cards()
    return found.length === 1 ? found : undefined
  })
  const items = ['ext:web', 'notes.read', 'site:a.example', 'site:b.example']
  assert.deepEqual(
    card.items
      .map((i) => i.item)
      .filter((i) => !i.startsWith('host:'))
      .sort(),
    items,
  )
  await f.decide(card.id, 'approve')
  const delivered = () => h.snapshots.findLast((s) => s.grants.length)
  await h.until(delivered)
  assert.deepEqual(
    delivered()
      ?.grants.map((g) => g.item)
      .sort(),
    items,
  )
  assert.deepEqual(
    (await f.grants())
      .map((g) => g.item)
      .filter((i) => !i.startsWith('host:'))
      .sort(),
    items,
  )
  assert.equal((await f.form(`/agents/${h.agent.id}/revoke`, {})).status, 303)
  await h.until(() => h.snapshots.at(-1)?.grants.length === 0)
  assert.deepEqual(
    (await f.grants()).filter((g) => !g.item.startsWith('host:')),
    [],
  )
})

const run = promisify(execFile)
const sshd = existsSync('/usr/sbin/sshd') && existsSync('/usr/bin/ssh-keygen')
test(
  'an approved ssh: grant runs a command through the jump server; a revoked one does not',
  { skip: !sshd && 'no sshd on this machine' },
  async (t) => {
    const f = await start(t)
    const dir = await mkdtemp(join(tmpdir(), 'speaker-ssh-'))
    const user = userInfo().username
    const port = await freePort()
    t.after(() => rm(dir, { recursive: true, force: true }))
    const speakerKey = (
      await (await f.call('/admin?section=services', { headers: { cookie: f.cookie() } })).text()
    ).match(/ssh-ed25519 [A-Za-z0-9+/=]+ speaker/)?.[0]
    assert.ok(speakerKey, 'the setup page shows speaker’s public key')
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host')])
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'agent')])
    await writeFile(join(dir, 'keys'), `from="127.0.0.1",restrict ${speakerKey}\n`)
    await writeFile(
      join(dir, 'sshd_config'),
      [
        `Port ${port}`,
        'ListenAddress 127.0.0.1',
        `HostKey ${join(dir, 'host')}`,
        'PidFile none',
        `AuthorizedKeysFile ${join(dir, 'keys')}`,
        'StrictModes no',
        'PasswordAuthentication no',
        'UsePAM no',
        `AllowUsers ${user}`,
        'LogLevel ERROR',
      ].join('\n'),
    )
    const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: 'inherit' })
    t.after(() => daemon.kill())
    for (let i = 0; i < 100 && (await run('nc', ['-z', '127.0.0.1', String(port)]).catch(() => null)) === null; i++)
      await sleep(50)
    await f.form('/ssh/targets/add', { alias: 'box', host: '127.0.0.1', port: String(port), account: user })
    const a = await f.enrol('ssh', {}, { sshKey: (await readFile(join(dir, 'agent.pub'), 'utf8')).trim() })
    await grant(f, a, 'ssh:box')
    const entry = (await a.catalog()).ssh.find((e: { item: string }) => e.item === 'ssh:box')
    await writeFile(join(dir, 'known_hosts'), `${entry.knownHosts.line}\n`)
    const command = entry.commands.find((c: string) => c.startsWith('ssh '))
    const ssh = () =>
      run(
        'sh',
        [
          '-c',
          command
            .replace(/^ssh /, 'ssh -F /dev/null ')
            .replace('<key>', join(dir, 'agent'))
            .replace('<known_hosts>', join(dir, 'known_hosts'))
            .replace('<command>', 'echo ran-as $(id -un)'),
        ],
        { timeout: 12_000 },
      )
    assert.equal((await ssh()).stdout.trim(), `ran-as ${user}`)
    await f.revoke('ssh:box')
    await assert.rejects(ssh())
  },
)

test('a card that widens what the agent holds is marked as wider; a first request is not', async (t) => {
  const f = await start(t)
  await f.saveService('a', { secret: 'a-key' })
  await f.saveService('a:b', { baseUrl: `${f.upstreamUrl}/base/sub` })
  const a = await f.enrol()
  const first = (await body(await a.as('/a/x'))).request
  const [plain] = await f.cards()
  assert.deepEqual(
    plain.items.map((i) => [i.item, !!i.wider]),
    [['a.read', false]],
  )
  await f.decide(first, 'deny')
  await grant(f, a, 'a:b.full')
  const wide = (await body(await a.as('/a/x', { method: 'POST', body: '{}' }))).request
  const [card] = await f.cards()
  assert.equal(card.id, wide)
  assert.deepEqual(
    card.items.map((i) => [i.item, !!i.wider]),
    [['a.full', true]],
  )
})

test('speaker serves nothing until the owner signs in after a restart, and grants do not survive it', async (t) => {
  const f = await notes(t)
  const a = await f.enrol()
  await grant(f, a, 'notes.read')
  assert.equal((await a.as('/notes/x')).status, 200)
  const r = await start(t, { dir: f.dir })
  const asAgent = (path: string, init: RequestInit = {}) =>
    r.call(path, { ...init, headers: { authorization: `Bearer anything` } })
  for (const response of [
    await asAgent('/notes/x'),
    await asAgent('/_speaker/catalog'),
    await r.call('/_speaker/hosts', r.json({})),
    await r.call('/_speaker/agents', r.json({})),
  ])
    assert.equal([response.status, await error(response)].join(), '503,locked')
  await r.signIn()
  const after = await r.call('/notes/x', { headers: { authorization: `Bearer ${a.token}` } })
  assert.notEqual(after.status, 200)
  assert.equal(r.seen.length, 0)
})

test("an agent's token used from another address is refused", async (t) => {
  const f = await start(t, { env: { TRUSTED_PROXY: '127.0.0.1' } })
  const a = await f.enrol('home', { 'x-forwarded-for': '100.64.0.7' })
  assert.equal((await a.as('/_speaker/catalog', {}, { 'x-forwarded-for': '100.64.0.7' })).status, 200)
  const away = await a.as('/_speaker/catalog', {}, { 'x-forwarded-for': '100.64.0.9' })
  assert.equal([away.status, await error(away)].join(), '401,enroll')
})

test('owner routes refuse another origin and accept the same origin, also behind a proxy', async (t) => {
  const f = await start(t)
  const input = {
    id: 'obsidian',
    baseUrl: 'https://notes.example.com/api',
    authType: 'bearer',
    secret: 'k',
    read: 'ask',
    write: 'never',
  }
  const cookie = f.cookie()
  const attempt = (origin: string | undefined, asJson: boolean, more: Record<string, string> = {}) =>
    f.call('/admin/services/save', {
      method: 'POST',
      headers: {
        cookie,
        ...(origin ? { origin } : {}),
        ...(asJson ? { 'content-type': 'application/json' } : {}),
        ...more,
      },
      body: asJson ? JSON.stringify(input) : new URLSearchParams(input),
    })
  for (const asJson of [false, true])
    assert.equal(
      (
        await attempt('https://untrusted.example.com', asJson, {
          'x-forwarded-host': 'untrusted.example.com',
          'x-forwarded-proto': 'https',
          'sec-fetch-site': 'cross-site',
        })
      ).status,
      403,
    )
  assert.equal((await attempt(undefined, false)).status, 403)
  assert.equal((await attempt('http://localhost', false)).status, 303)
  assert.equal(
    (
      await attempt('https://speaker.example.com', false, {
        'sec-fetch-site': 'same-origin',
        'x-forwarded-proto': 'https',
      })
    ).status,
    303,
  )
})

test("a sandboxed agent's token reaches no owner route or other agent's request; a direct agent cannot ask for sandbox items", async (t) => {
  const f = await notes(t)
  const h = await sandbox(t, f)
  const other = await f.enrol('other')
  const theirs = await other.ask(['notes.read'])
  for (const response of [
    await h.as('/admin/api/pending'),
    await h.as(`/admin/requests/${theirs}/approve`, { method: 'POST' }),
    await h.as(`/_speaker/requests/${theirs}`),
  ])
    assert.ok([401, 403, 404].includes(response.status), `answered ${response.status}`)
  assert.equal((await f.grants()).filter((g) => !g.item.startsWith('host:')).length, 0)
  const site = await other.as('/_speaker/requests', f.json({ want: ['site:example.com'], reason: 'x' }))
  assert.equal([site.status, await error(site)].join(), '400,invalid')
})

test('every decision and proxied call is logged with who, what and the result, and no secret', async (t) => {
  const f = await notes(t)
  const a = await f.enrol('auditor')
  await f.decide(await a.ask(['notes.read']), 'approve')
  await a.as('/notes/x')
  await a.as('/notes/x', { method: 'PUT', body: '{}' })
  const denied = await a.ask(['notes.full'])
  await f.decide(denied, 'deny')
  await f.revoke('notes.read')
  const log = await f.audit()
  const has = (event: string, fields: object) =>
    log.some((e) => e.event === event && Object.entries(fields).every(([k, v]) => e[k] === v))
  assert.ok(has('agent_enrolled', { agent: a.id }))
  assert.ok(has('request_created', { agent: a.id }))
  assert.ok(has('grant_created', { agent: a.id, item: 'notes.read' }))
  assert.ok(has('proxy', { agent: a.id, service: 'notes', method: 'GET', status: 200 }))
  assert.ok(
    has('proxy', {
      agent: a.id,
      service: 'notes',
      method: 'GET',
      status: 200,
      grant: log.find((e) => e.event === 'grant_created')?.grant,
    }),
  )
  assert.ok(
    log.some((e) => e.request === denied && JSON.stringify(e.denied) === '["notes.full"]'),
    'the denial is recorded',
  )
  assert.ok(
    log.some((e) => e.event === 'grant_revoked' && e.agent === a.id && e.item === 'notes.read'),
    'the revoke is recorded',
  )
  assert.ok(!JSON.stringify(log).includes(KEY))
})

test('a wrong owner password is refused, and repeated failures are cut off even for the right one', async (t) => {
  const f = await start(t)
  for (let i = 0; i < 5; i++)
    assert.equal((await f.post('/admin/signin', { password: 'not the password' })).status, 401)
  assert.equal((await f.post('/admin/signin', { password: ownerPassword })).status, 429)
})

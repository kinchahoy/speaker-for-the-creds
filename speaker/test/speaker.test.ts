import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { connect, getCACertificates, setDefaultCACertificates } from 'node:tls'
import { once } from 'node:events'
import { mkdir, mkdtemp, symlink, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
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

test('an unknown service names only what the agent holds, and an upstream 404 says which path was tried, without the key', async (t) => {
  const f = await notes(t)
  assert.equal((await f.saveService('vault', { secret: KEY })).status, 303)
  const a = await f.enrol()
  await grant(f, a, 'notes.read')
  const unknown = await body(await a.as('/zzz/x'))
  assert.equal(unknown.next, 'You hold: notes. GET /_speaker/catalog')
  assert.match((await body(await a.as('/notess/x'))).next, /Did you mean "notes"/)
  const missing = await a.as('/notes/missing')
  assert.deepEqual([missing.status, missing.headers.get('speaker-upstream-path')], [404, '/base/missing'])
  assert.ok(![...missing.headers.values()].join().includes(KEY))
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
const noSshd = !(existsSync('/usr/sbin/sshd') && existsSync('/usr/bin/ssh-keygen')) && 'no sshd on this machine'

// Speaker in front of a throwaway non-root sshd standing in for a homelab host `box`, and an agent with its own key.
async function jump(t: TestContext) {
  const f = await start(t)
  const dir = await mkdtemp(join(tmpdir(), 'speaker-ssh-'))
  const user = userInfo().username
  const port = await freePort()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const page = await (await f.call('/admin?section=services', { headers: { cookie: f.cookie() } })).text()
  const speakerKey = page.match(/ssh-ed25519 [A-Za-z0-9+/=]+ speaker/)?.[0]
  assert.ok(speakerKey, 'the setup page shows speaker’s public key')
  for (const name of ['host', 'agent'])
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)])
  await writeFile(join(dir, 'keys'), `from="127.0.0.1",restrict ${speakerKey}\n`)
  const config = [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'host')}`, 'PidFile none']
  config.push(`AuthorizedKeysFile ${join(dir, 'keys')}`, 'StrictModes no', 'PasswordAuthentication no', 'UsePAM no')
  await writeFile(join(dir, 'sshd_config'), [...config, `AllowUsers ${user}`, 'LogLevel ERROR'].join('\n'))
  const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: 'inherit' })
  t.after(() => daemon.kill())
  for (let i = 0; i < 100 && (await run('nc', ['-z', '127.0.0.1', String(port)]).catch(() => null)) === null; i++)
    await sleep(50)
  await f.form('/ssh/targets/add', { alias: 'box', host: '127.0.0.1', port: String(port), account: user })
  const a = await f.enrol('ssh', {}, { sshKey: (await readFile(join(dir, 'agent.pub'), 'utf8')).trim() })
  // Runs the command line /catalog prints for an item (as the agent would, with its own key), filling `fill` in.
  const line = async (item: string, kind: string, fill: Record<string, string> = {}) => {
    const entry = (await a.catalog()).ssh.find((e: { item: string }) => e.item === item)
    await writeFile(join(dir, 'known_hosts'), `${entry.knownHosts.line}\n`)
    const filled = { '<key>': join(dir, 'agent'), '<known_hosts>': join(dir, 'known_hosts'), ...fill }
    const text = entry.commands.find((c: string) => c.startsWith(`${kind} `)).replace(/^(\w+) /, '$1 -F /dev/null ')
    return Object.entries(filled).reduce((l, [k, v]) => l.replaceAll(k, v), text)
  }
  const sh = (command: string) => run('sh', ['-c', command], { timeout: 12_000 })
  return { f, a, dir, user, line, sh }
}

test(
  'an approved ssh: grant runs a command through the jump server; a revoked one does not',
  { skip: noSshd },
  async (t) => {
    const { f, a, user, line, sh } = await jump(t)
    await grant(f, a, 'ssh:box')
    const ssh = async () => sh(await line('ssh:box', 'ssh', { '<command>': 'echo ran-as $(id -un)' }))
    assert.equal((await ssh()).stdout.trim(), `ran-as ${user}`)
    await f.revoke('ssh:box')
    await assert.rejects(ssh())
  },
)

test(
  'a folder grant is sftp inside its share: reads work, outside paths and read-only writes do not',
  { skip: noSshd },
  async (t) => {
    const { f, a, dir, line, sh } = await jump(t)
    const world = join(dir, 'world')
    for (const name of ['pics', 'docs']) {
      await mkdir(join(world, name), { recursive: true })
      assert.equal((await f.form('/ssh/shares/save', { name, target: 'box', path: join(world, name) })).status, 303)
    }
    await writeFile(join(world, 'pics', 'hello.txt'), 'hello from pics\n')
    await writeFile(join(world, 'outside.txt'), 'not in any share\n')
    await symlink('../outside.txt', join(world, 'pics', 'escape'))
    await writeFile(join(dir, 'up.txt'), 'upload\n')
    assert.deepEqual((await a.catalog()).ssh, [], 'nothing before the grant')
    await grant(f, a, 'folder:pics', 'folder:docs:rw')
    // One sftp session running `commands`; the exit code and what landed on disk are the outcome.
    const sftp = async (item: string, ...commands: string[]) => {
      await writeFile(join(dir, 'batch'), `${commands.join('\n')}\n`)
      const text = (await line(item, 'sftp', { '/<path>': '' })).replace(/^sftp /, `sftp -b ${join(dir, 'batch')} `)
      return sh(text).then(
        () => 0,
        (e: { code?: number }) => e.code ?? 1,
      )
    }
    const got = (name: string) => join(dir, name)
    assert.equal(await sftp('folder:pics', `get /pics/hello.txt ${got('a')}`, `ls /pics`), 0)
    assert.equal(await readFile(got('a'), 'utf8'), 'hello from pics\n')
    for (const [name, remote] of [
      ['dotdot', '/pics/../outside.txt'],
      ['absolute', join(world, 'outside.txt')],
      ['symlink', '/pics/escape'],
    ])
      assert.notEqual(await sftp('folder:pics', `get ${remote} ${got(name)}`), 0, name)
    for (const name of ['dotdot', 'absolute', 'symlink']) assert.equal(existsSync(got(name)), false, name)
    assert.notEqual(await sftp('folder:pics', `put ${got('up.txt')} /pics/new.txt`), 0)
    assert.equal(existsSync(join(world, 'pics', 'new.txt')), false)
    assert.equal(await sftp('folder:docs:rw', `put ${got('up.txt')} /docs/new.txt`), 0)
    assert.equal(await readFile(join(world, 'docs', 'new.txt'), 'utf8'), 'upload\n')
    assert.notEqual(await sftp('folder:docs:rw', `put ${got('up.txt')} /docs/../pics/hijack.txt`), 0)
    assert.equal(existsSync(join(world, 'pics', 'hijack.txt')), false)
    await f.revoke('folder:pics')
    assert.deepEqual(
      (await a.catalog()).ssh.map((e: { item: string }) => e.item),
      ['folder:docs:rw'],
    )
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

// CONNECT through speaker's proxy as the agent, then speak TLS (trusting speaker's certificate) to the target.
async function viaProxy(f: Fixture, token: string, host: string, port: number, authorization: string) {
  const ca = await (await f.call('/_speaker/proxy/ca.pem')).text()
  const connecting = httpRequest({
    port: f.proxyPort,
    host: '127.0.0.1',
    method: 'CONNECT',
    path: `${host}:${port}`,
    headers: { 'proxy-authorization': `Basic ${Buffer.from(`agent:${token}`).toString('base64')}` },
  }).end()
  const [answer, socket] = await once(connecting, 'connect')
  if (answer.statusCode !== 200) return answer.statusCode as number
  const tls = connect({ socket, servername: host, ca })
  const sent = httpRequest({ createConnection: () => tls, host, port, headers: { authorization } }).end()
  const [response] = await once(sent, 'response')
  tls.destroy()
  return response.statusCode as number
}

test('the proxy swaps an inserted secret’s placeholder for the real value, for its allowed host and only with the grant', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'speaker-tls-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pem = (name: string) => join(dir, name)
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
    '-keyout',
    pem('key'),
    '-out',
    pem('cert'),
  ])
  const identity = { key: await readFile(pem('key')), cert: await readFile(pem('cert')) }
  setDefaultCACertificates([...getCACertificates('default'), identity.cert.toString()])
  const received: unknown[] = []
  const upstream = httpsServer(identity, (req, res) => {
    received.push(req.headers.authorization)
    res.end('ok')
  }).listen(0)
  t.after(() => {
    upstream.closeAllConnections()
    upstream.close()
  })
  await once(upstream, 'listening')
  const port = (upstream.address() as { port: number }).port

  const f = await start(t)
  const real = 'ghp_real_token_only_the_upstream_should_see'
  await f.form('/secrets/save', { name: 'GH', value: real, hosts: 'localhost', env: 'GH_TOKEN' })
  const a = await f.enrol()
  const proxied = (host: string) => viaProxy(f, a.token, host, port, `Bearer ${placeholder}`)
  let placeholder = ''
  assert.equal(await viaProxy(f, a.token, 'localhost', port, 'x'), 403, 'no grant, no tunnel')
  await grant(f, a, 'secret:GH')
  placeholder = (await a.catalog()).secrets.GH.environment.GH_TOKEN
  assert.ok(!placeholder.includes(real))
  assert.equal(await proxied('localhost'), 200)
  assert.deepEqual(received, [`Bearer ${real}`])
  assert.equal(await proxied('example.org'), 403, 'a host the secret does not cover gets no tunnel')
  assert.deepEqual(received, [`Bearer ${real}`])
})

// The dev Chromium from Playwright's cache; the broker runs as this same user here.
const chromium = () => {
  const cache = join(homedir(), '.cache/ms-playwright')
  const found = (existsSync(cache) ? readdirSync(cache) : [])
    .filter((name) => /^chromium-\d+$/.test(name))
    .map((name) => join(cache, name, 'chrome-linux64/chrome'))
    .findLast(existsSync)
  assert.ok(found, `No Chromium in ${cache}: run pnpm dlx playwright install chromium`)
  return found
}

test('a browser site: the owner signs in through the live view, then a granted agent drives it with allowlisted commands', async (t) => {
  // A login form that sets a cookie and greets the signed-in user.
  const site = createServer((req, res) => {
    if (req.method === 'POST') {
      let form = ''
      req.on('data', (chunk) => (form += chunk))
      req.on('end', () => {
        const user = new URLSearchParams(form).get('username')
        res.writeHead(302, { 'set-cookie': `sid=${user}; HttpOnly`, location: '/home' }).end()
      })
      return
    }
    const user = /sid=(\w+)/.exec(req.headers.cookie ?? '')?.[1]
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      req.url === '/home'
        ? `<h1>${user ? `Welcome ${user}` : 'not signed in'}</h1>`
        : '<title>Login</title><form method=post action=/login><input name=username placeholder=username aria-label=username><input name=password type=password aria-label=password><button>Sign in</button></form>',
    )
  })
  site.listen(0, '127.0.0.1')
  await once(site, 'listening')
  const startUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`
  const token = 'browser-broker-token-for-tests-0123456789'
  const port = await freePort()
  const broker = spawn('node', ['browser-broker.ts'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      BROWSER_BROKER_PORT: String(port),
      BROWSER_BROKER_TOKEN: token,
      AGENT_BROWSER_EXECUTABLE_PATH: chromium(),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => {
    broker.kill()
    site.close()
  })
  await once(broker.stdout, 'data')
  const f = await start(t, { env: { BROWSER_BROKER_URL: `http://127.0.0.1:${port}`, BROWSER_BROKER_TOKEN: token } })
  assert.equal((await f.form('/browsers/save', { name: 'shop', startUrl, domains: '127.0.0.1' })).status, 303)
  const opened = await f.form('/browser/shop/open', { life: '1h' })
  assert.deepEqual([opened.status, opened.headers.get('location')], [303, '/admin/browser/shop'])
  const page = await f.call('/admin/browser/shop', { headers: { cookie: f.cookie() } })
  assert.match(await page.text(), /<canvas/)
  const setupPage = await (await f.call('/admin?section=services', { headers: { cookie: f.cookie() } })).text()
  assert.match(setupPage, /id="setup-browsers"[\s\S]*shop[\s\S]*open, closes/)

  // The live view: only from the public origin, with the owner's cookie.
  const view = (origin: string) =>
    new WebSocket(`${f.url.replace('http', 'ws')}/admin/browser/shop/ws`, { headers: { cookie: f.cookie(), origin } })
  const [, refused] = await once(
    view('http://evil.example').on('error', () => undefined),
    'unexpected-response',
  )
  assert.equal((refused as { statusCode: number }).statusCode, 403)
  const ws = view('http://localhost')
  const [frame] = (await once(ws, 'message')) as [Buffer]
  assert.deepEqual([...frame.subarray(0, 2)], [0xff, 0xd8], 'frames arrive as JPEG')
  const send = (message: object) => ws.send(JSON.stringify(message))
  const click = async (x: number, y: number) => {
    for (const eventType of ['mousePressed', 'mouseReleased'])
      send({ type: 'input_mouse', eventType, x, y, button: 'left', clickCount: 1 })
    await sleep(200)
  }
  const type = (text: string) => [...text].forEach((c) => send({ type: 'input_keyboard', eventType: 'char', text: c }))
  await click(100, 18)
  type('carol')
  send({ type: 'navigate', url: 'http://example.com/' }) // anything but input is dropped
  await click(285, 18)
  type('pw')
  const enter = { type: 'input_keyboard', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
  send({ ...enter, eventType: 'keyDown', text: '\r' })
  send({ ...enter, eventType: 'keyUp' })
  await sleep(1000)
  ws.close()

  // The agent: asks on use, then commands; arguments never reach the log.
  const a = await f.enrol()
  const command = (args: string[], name = 'shop') => a.as(`/_speaker/browser/${name}`, f.json({ args }))
  assert.equal(await error(await command(['snapshot', '-i'])), 'approval_required')
  await grant(f, a, 'browser:shop')
  const snapshot = await command(['snapshot'])
  assert.match(await snapshot.text(), /Welcome carol/)
  assert.match(await (await command(['get', 'url'])).text(), /\/home$/)
  const shot = await command(['screenshot'])
  assert.equal(shot.headers.get('content-type'), 'image/png')
  assert.deepEqual([...new Uint8Array(await shot.arrayBuffer()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
  for (const args of [
    ['eval', '1'],
    ['fill', 'e1', '--session', 'other'],
    ['open', 'http://example.com/'],
  ])
    assert.equal((await command(args)).status, 400, args.join(' '))
  assert.equal((await command(['snapshot'], 'nowhere')).status, 404)
  assert.deepEqual((await a.catalog()).browsers.shop.open, true)

  assert.equal((await f.form('/browser/shop/close', {})).status, 303)
  assert.equal((await command(['snapshot'])).status, 409)
  await f.revoke('browser:shop')
  assert.equal((await command(['snapshot'])).status, 403)
  const logged = (await f.audit()).filter((e) => e.event === 'browser_command')
  assert.deepEqual(
    logged.map((e) => e.command),
    ['snapshot', 'get', 'screenshot'],
  )
})

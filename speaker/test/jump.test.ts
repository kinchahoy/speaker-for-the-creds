import assert from 'node:assert/strict'
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { type AddressInfo, connect, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { serve } from '@hono/node-server'
import WebSocket, { WebSocketServer } from 'ws'
import { createJump } from '../jump.ts'
import { createApp, readConfig } from '../server.ts'
import { generateSshKey } from '../store.ts'
import { setOwnerPassword } from './owner.ts'

const run = promisify(execFile)
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const user = userInfo().username

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  server.close()
  await once(server, 'close')
  return port
}
async function listening(port: number) {
  for (let i = 0; i < 100; i++) {
    const open = await new Promise<boolean>((done) => {
      const probe = connect(port, '127.0.0.1')
      probe.once('connect', () => {
        probe.destroy()
        done(true)
      })
      probe.once('error', () => done(false))
    })
    if (open) return
    await sleep(50)
  }
  throw new Error(`Nothing listens on ${port}`)
}
// Runs a shell line and reports what happened instead of throwing on a failed exit.
const sh = (line: string) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
    execFile('sh', ['-c', line], { timeout: 12_000 }, (error, stdout, stderr) =>
      done({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    ),
  )

type Fixture = Awaited<ReturnType<typeof fixture>>

// Speaker (serving HTTP, jump server enabled) in front of a throwaway non-root sshd standing in for a homelab host.
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'speaker-jump-'))
  const world = join(dir, 'world')
  await mkdir(join(dir, 'data'))
  await writeFile(
    join(dir, 'data', 'groups.json'),
    JSON.stringify({ ops: { description: 'Ops', items: ['ssh:box', 'folder:pics', 'folder:docs:rw'] } }),
  )
  for (const name of ['pics', 'docs']) await mkdir(join(world, name), { recursive: true })
  await writeFile(join(world, 'pics', 'hello.txt'), 'hello from pics\n')
  await writeFile(join(world, 'outside.txt'), 'not in any share\n')
  await symlink('../outside.txt', join(world, 'pics', 'escape'))
  const sshPort = await freePort()
  const targetPort = await freePort()
  const app = await createApp(
    readConfig({ DATA_DIR: join(dir, 'data'), PUBLIC_URL: 'http://localhost', SSH_PORT: String(sshPort) }),
  )
  const server = serve({
    fetch: app.fetch,
    port: 0,
    hostname: '127.0.0.1',
    websocket: { server: new WebSocketServer({ noServer: true }) },
  }) as Server
  await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let target: ChildProcess | undefined
  t.after(async () => {
    await app.stop()
    target?.kill()
    server.closeAllConnections()
    server.close()
    await rm(dir, { recursive: true, force: true })
  })

  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init }))
  const owner = { cookie: await setOwnerPassword(call), origin: 'http://localhost' }
  const ownerGet = async (path: string) => (await call(path, { headers: owner })).text()
  const ownerForm = (path: string, body: [string, string][]) =>
    call(`/admin${path}`, { method: 'POST', headers: owner, body: new URLSearchParams(body) })

  // The target accepts speaker's key, from speaker's address only, as the owner's instructions say.
  const speakerKey = (await ownerGet('/admin?section=services')).match(/ssh-ed25519 [A-Za-z0-9+/=]+ speaker/)?.[0]
  assert.ok(speakerKey, 'Setup shows speaker’s public key')
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'target_host')])
  await writeFile(join(dir, 'target_keys'), `from="127.0.0.1",restrict ${speakerKey}\n`)
  await writeFile(
    join(dir, 'target_config'),
    [
      `Port ${targetPort}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${join(dir, 'target_host')}`,
      'PidFile none',
      `AuthorizedKeysFile ${join(dir, 'target_keys')}`,
      'StrictModes no',
      'PasswordAuthentication no',
      'UsePAM no',
      `AllowUsers ${user}`,
      'Subsystem sftp /usr/lib/openssh/sftp-server',
      'LogLevel ERROR',
    ].join('\n'),
  )
  target = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(dir, 'target_config')], { stdio: 'inherit' })
  await listening(targetPort)
  const added = await ownerForm('/ssh/targets/add', [
    ['alias', 'box'],
    ['host', '127.0.0.1'],
    ['port', String(targetPort)],
    ['account', user],
  ])
  assert.equal(added.headers.get('location'), '/admin?section=services')
  for (const name of ['pics', 'docs'])
    await ownerForm('/ssh/shares/save', [
      ['name', name],
      ['target', 'box'],
      ['path', join(world, name)],
      ['delivery', 'ssh'],
    ])

  // An agent with its own throwaway key, enrolled over real HTTP so speaker sees its address.
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'agent_key')])
  const sshKey = (await readFile(join(dir, 'agent_key.pub'), 'utf8')).trim()
  const bearer = { authorization: 'Bearer jump-token', 'content-type': 'application/json' }
  const agent = (path: string, init: RequestInit = {}) => fetch(url + path, { headers: bearer, ...init })
  const enroll = (want: string[], body: object = { sshKey }) =>
    fetch(`${url}/_speaker/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'fix photos', tokenHash: sha('jump-token'), want, reason: 'test', ...body }),
    })
  // Approves the agent's pending request in full, as the owner would from the card.
  async function approve(duration = '1h') {
    const page = await ownerGet('/admin')
    const id = page.match(/id="request-([a-f0-9]+)"/)?.[1]
    assert.ok(id, 'a card is waiting')
    const shown = [...page.matchAll(/name="shown" type="hidden" value="([^"]+)"/g)].map((m) => m[1])
    const response = await ownerForm(`/requests/${id}/approve`, [
      ['duration', duration],
      ...shown.map((item): [string, string] => ['items', item]),
      ...shown.map((item): [string, string] => ['shown', item]),
    ])
    assert.equal(response.status, 303)
    return page
  }
  const me = async () =>
    (await (await agent('/_speaker/me')).json()) as {
      ssh: { item: string; commands: string[]; knownHosts: { line: string } }[]
    }
  // The command line /me prints for an item, with the agent's own details filled in.
  async function line(item: string, which: 'ssh' | 'sftp' | 'sshfs' | 'scp', fill: Record<string, string> = {}) {
    const found = (await me()).ssh.find((entry) => entry.item === item)
    const text = found?.commands.find((c) => c.startsWith(which))
    assert.ok(text, `${item} has a ${which} line in /me`)
    // The one-time step /me gives: save the jump server's host key line.
    await writeFile(join(dir, 'known_hosts'), `${found?.knownHosts.line}\n`)
    const filled = { '<key>': join(dir, 'agent_key'), '<known_hosts>': join(dir, 'known_hosts'), ...fill }
    return Object.entries(filled).reduce((l, [k, v]) => l.replaceAll(k, v), text)
  }
  return { dir, world, url, owner, ownerGet, ownerForm, agent, enroll, approve, me, line, sshPort }
}

test('a command runs through the jump server as the target account and is logged; revoke ends a running session', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.enroll(['ssh:box'])).status, 201)
  assert.ok((await f.approve()).includes(`commands as ${user}@127.0.0.1:`), 'the card shows the account')
  const lineOf = await f.line('ssh:box', 'ssh', { '<command>': 'echo ran-as $(id -un); exit 3' })
  assert.match(lineOf, new RegExp(`^ssh -p ${f.sshPort} -i \\S+ -o IdentitiesOnly=yes -o BatchMode=yes `))
  const ran = await sh(lineOf)
  assert.equal(ran.stdout.trim(), `ran-as ${user}`)
  assert.equal(ran.code, 3, 'the remote exit code comes back')
  // An option-looking command is a command, never an option of the local ssh.
  const odd = await sh(await f.line('ssh:box', 'ssh', { '<command>': '-oProxyCommand=touch\\ /tmp/speaker-pwned' }))
  assert.notEqual(odd.code, 0)
  assert.equal(existsSync('/tmp/speaker-pwned'), false)
  const log = await f.ownerGet('/admin/log')
  assert.match(log, /echo ran-as \$\(id -un\); exit 3/)

  // The grant also allows sftp as that account: paths are <target>/<absolute path on the target>.
  const file = join(f.dir, 'batch')
  await writeFile(file, `get /box${f.world}/outside.txt ${join(f.dir, 'via-box.txt')}\n`)
  const sftp = (await f.line('ssh:box', 'sftp')).replace(/ \S+:box\/<absolute path on box>$/, ` ${user}@127.0.0.1`)
  assert.equal((await sh(sftp.replace(/^sftp /, `sftp -b ${file} `))).code, 0)
  assert.equal(await readFile(join(f.dir, 'via-box.txt'), 'utf8'), 'not in any share\n')

  // A session that is running when the owner revokes the grant is ended, with one line on stderr.
  const running = spawn('sh', ['-c', await f.line('ssh:box', 'ssh', { '<command>': 'sleep 30' })])
  let errors = ''
  running.stderr.on('data', (chunk) => {
    errors += chunk
  })
  const live = async () => JSON.parse(await f.ownerGet('/admin/live')) as { grants: string }
  for (let i = 0; i < 60 && !(await live()).grants.includes('SSH session open'); i++) await sleep(100)
  const panel = (await live()).grants
  assert.match(panel, /End/)
  const grant = panel.match(/id="grant-([a-f0-9]+)"[\s\S]*?<code>ssh:box<\/code>/)?.[1]
  assert.ok(grant)
  const started = Date.now()
  assert.equal((await f.ownerForm('/grants/revoke', [['id', grant]])).status, 303)
  const [code] = (await once(running, 'close')) as [number]
  assert.notEqual(code, 0)
  assert.ok(Date.now() - started < 5000, 'the session ends promptly')
  assert.match(errors, /speaker: the session ended: its grant ended\. Check GET \/_speaker\/me/)
  assert.deepEqual((await f.me()).ssh, [])
  assert.match(await f.ownerGet('/admin/log'), /ssh session end/)
})

test('a folder grant is SFTP inside its share: reads work, other paths, writes on read-only, symlinks and commands do not', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.enroll(['folder:pics', 'folder:docs:rw'])).status, 201)
  const card = await f.approve()
  assert.match(card, /box:\S+\/pics · read-only · over SSH/)
  assert.match(card, /box:\S+\/docs · read-write · over SSH/)
  const batch = async (item: string, commands: string[]) => {
    const file = join(f.dir, 'batch')
    await writeFile(file, `${commands.join('\n')}\n`)
    const text = await f.line(item, 'sftp', { '/<path>': '' })
    return sh(text.replace(/^sftp /, `sftp -b ${file} `))
  }
  const out = (name: string) => join(f.dir, name)

  const read = await batch('folder:pics', [`get /pics/hello.txt ${out('got.txt')}`])
  assert.equal(read.code, 0, read.stderr)
  assert.equal(await readFile(out('got.txt'), 'utf8'), 'hello from pics\n')

  const outside = await batch('folder:pics', [`get /pics/../outside.txt ${out('o1')}`])
  assert.notEqual(outside.code, 0)
  assert.equal(existsSync(out('o1')), false)
  // A symlink inside the share that leads out of it is resolved on the target and refused.
  const linked = await batch('folder:pics', [`get /pics/escape ${out('o2')}`])
  assert.notEqual(linked.code, 0)
  assert.equal(existsSync(out('o2')), false)

  await writeFile(out('up.txt'), 'upload\n')
  const readOnly = await batch('folder:pics', [`put ${out('up.txt')} /pics/new.txt`])
  assert.notEqual(readOnly.code, 0)
  assert.equal(existsSync(join(f.world, 'pics', 'new.txt')), false)

  const write = await batch('folder:docs:rw', [`put ${out('up.txt')} /docs/new.txt`])
  assert.equal(write.code, 0, write.stderr)
  assert.equal(await readFile(join(f.world, 'docs', 'new.txt'), 'utf8'), 'upload\n')
  const link = await batch('folder:docs:rw', ['ln -s new.txt /docs/link'])
  assert.notEqual(link.code, 0)
  assert.equal(existsSync(join(f.world, 'docs', 'link')), false)

  // Modern scp is SFTP too and works; legacy scp -O is refused with a pointer to sftp.
  const scp = await f.line('folder:docs:rw', 'scp', { '<file>': out('up.txt'), '<path>': 'scp.txt' })
  assert.equal((await sh(scp)).code, 0)
  assert.equal(await readFile(join(f.world, 'docs', 'scp.txt'), 'utf8'), 'upload\n')
  const legacy = await sh(scp.replace(/^scp /, 'scp -O '))
  assert.notEqual(legacy.code, 0)
  assert.match(legacy.stderr, /use sftp/)

  // Commands on a folder grant are refused with a pointer to sftp.
  const command = await sh(
    `${(await f.line('folder:pics', 'sftp')).replace(/^sftp -P (\d+)/, 'ssh -p $1').replace(/ \S+:pics\/<path>$/, ` ${user}@127.0.0.1 pics ls`)}`,
  )
  assert.notEqual(command.code, 0)
  assert.match(command.stderr, /use sftp/)

  const log = await f.ownerGet('/admin/log')
  for (const text of [
    '/pics/hello.txt',
    'open (write)',
    '/docs/new.txt',
    'Outside the share',
    'This grant is read-only',
  ])
    assert.ok(log.includes(text), `the log has ${text}`)
})

test('names that do not exist or cannot be delivered are denied at once, logged, and never become a card', async (t) => {
  const f = await fixture(t)
  const response = await f.enroll(['ssh:nope', 'folder:nope'])
  const { request } = (await response.json()) as { request: { status: string; granted: string[]; denied: string[] } }
  assert.deepEqual([request.status, request.granted, request.denied], ['decided', [], ['ssh:nope', 'folder:nope']])
  assert.doesNotMatch(await f.ownerGet('/admin'), /id="request-/)
  const log = await f.ownerGet('/admin/log')
  assert.match(log, /request unavailable/)
  assert.ok(log.includes('there is no target named nope'))
  // An agent that never sent a key cannot ask for SSH at all.
  assert.equal((await f.enroll(['ssh:nope'], { tokenHash: sha('keyless') })).status, 400)
  // The owner cannot add root as a target by accident.
  const root = await f.ownerForm('/ssh/targets/add', [
    ['alias', 'rooted'],
    ['host', '127.0.0.1'],
    ['port', '22'],
    ['account', 'root'],
  ])
  assert.match(decodeURIComponent(root.headers.get('location') ?? ''), /sshError=Refused: root has no limits/)
  // A group naming targets and shares shows the agent only a count, never the names.
  const { groups } = (await (await f.agent('/_speaker/me')).json()) as { groups: object }
  assert.deepEqual(groups, { ops: { description: 'Ops', items: [], also: '1 SSH target, 2 folders' } })
})

test('without SSH_PORT, SSH and folders are off and answered denied', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'speaker-nojump-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = await createApp(readConfig({ DATA_DIR: dir, PUBLIC_URL: 'http://localhost' }))
  const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://localhost${path}`, init))
  await setOwnerPassword(call)
  const key = (
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'k'), '-C', 'a']).then(() =>
      readFile(join(dir, 'k.pub'), 'utf8'),
    )
  ).trim()
  const response = await call('/_speaker/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'x', tokenHash: sha('t'), want: ['ssh:box'], reason: 'r', sshKey: key }),
  })
  const { request } = (await response.json()) as { request: { denied: string[] } }
  assert.deepEqual(request.denied, ['ssh:box'])
  await app.stop()
})

// An approved sandbox host whose WebSocket has reported `shares`; collects the grants of every snapshot it hears.
async function sandboxHost(f: Fixture, t: TestContext, shares: { name: string; mount: boolean }[]) {
  const post = (path: string, token: string, body: object) =>
    f.agent(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const created = await post('/_speaker/hosts', '', { name: 'sandbox', kinds: ['site'], tokenHash: sha('host-token') })
  const { id } = (await created.json()) as { id: string }
  assert.equal((await f.ownerForm(`/hosts/${id}/approve`, [])).status, 303)
  const { token } = (await (
    await post('/_speaker/hosts/agents', 'host-token', { label: 'pi', agent: 'Pi' })
  ).json()) as {
    token: string
  }
  const ws = new WebSocket(`${f.url.replace('http', 'ws')}/_speaker/hosts/ws`, {
    headers: { authorization: 'Bearer host-token' },
  })
  t.after(() => ws.terminate())
  const grants: { item: string }[][] = []
  ws.on('message', (data) => grants.push((JSON.parse(String(data)) as { grants: { item: string }[] }).grants))
  await once(ws, 'open')
  ws.send(JSON.stringify({ type: 'shares', shares }))
  // Speaker answers a share report with a new snapshot (the first came on connect).
  for (let i = 0; i < 100 && grants.length < 2; i++) await sleep(20)
  assert.ok(grants.length >= 2, 'speaker took the share report')
  return {
    ask: (body: object) => post('/_speaker/requests', token, { reason: 'test', duration: '1h', ...body }),
    // The items /me offers this agent SSH commands for: its over-SSH grants.
    overSsh: async () =>
      (
        (await (await f.agent('/_speaker/me', { headers: { authorization: `Bearer ${token}` } })).json()) as {
          ssh?: { item: string }[]
        }
      ).ssh?.map((entry) => entry.item) ?? [],
    grants,
  }
}
const saveShare = (f: Fixture, name: string, delivery: string) =>
  f.ownerForm('/ssh/shares/save', [
    ['name', name],
    ['target', 'box'],
    ['path', join(f.world, 'pics')],
    ['delivery', delivery],
  ])

// The sandbox host reports each share it holds with `mount`; that, not its registered kinds, picks the delivery.
test('a folder the sandbox host reported mountable needs no sshKey from the agent', async (t) => {
  const f = await fixture(t)
  await saveShare(f, 'mounted', 'both')
  const host = await sandboxHost(f, t, [{ name: 'mounted', mount: true }])
  assert.equal((await host.ask({ want: ['folder:mounted'] })).status, 202) // a card is waiting
  // The same agent still needs a key for anything delivered over SSH.
  assert.equal((await host.ask({ want: ['folder:pics'] })).status, 400)
})

test('a folder the sandbox host reported not mountable needs an sshKey', async (t) => {
  const f = await fixture(t)
  await saveShare(f, 'mixed', 'both')
  const host = await sandboxHost(f, t, [{ name: 'mixed', mount: false }])
  assert.equal((await host.ask({ want: ['folder:mixed'] })).status, 400)
})

for (const [mount, overSsh] of [
  [false, true],
  [true, false],
] as const) {
  test(`a share reported mount: ${mount} is delivered ${overSsh ? 'over SSH' : 'as a VM mount'}, and the host hears the grant either way`, async (t) => {
    const f = await fixture(t)
    await saveShare(f, 'mixed', 'both')
    const host = await sandboxHost(f, t, [{ name: 'mixed', mount }])
    const sshKey = (await readFile(join(f.dir, 'agent_key.pub'), 'utf8')).trim()
    assert.equal((await host.ask({ want: ['folder:mixed'], sshKey })).status, 202)
    await f.approve()
    // Over SSH the host mounts it with sshfs, so it must hear the grant; a VM mount it hears as it always did.
    for (let i = 0; i < 40 && !host.grants.some((list) => list.length); i++) await sleep(50)
    assert.ok(host.grants.some((list) => list.some((grant) => grant.item === 'folder:mixed')))
    assert.deepEqual(await host.overSsh(), overSsh ? ['folder:mixed'] : [])
  })
}

// Stopping speaker removes its runtime directory. It used to keep speaker.pub when the ssh-agent, killed first,
// removed its socket while the directory was being deleted, so this repeats start and stop to catch that race.
test('stop removes the temporary directory of the jump server', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'speaker-jumpdata-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const key = await generateSshKey()
  const left: string[] = []
  for (let i = 0; i < 25; i++) {
    const jump = await createJump({
      port: await freePort(),
      dataDir,
      agent: () => undefined,
      grants: () => [],
      mountable: () => false,
      audit: () => undefined,
      expire: () => undefined,
    })
    await jump.start(key)
    await jump.stop()
    for (const name of await readdir(tmpdir()))
      if (
        /^speaker-[A-Za-z0-9]{6}$/.test(name) &&
        (await readFile(join(tmpdir(), name, 'speaker.pub'), 'utf8').catch(() => '')).startsWith(key.public)
      )
        left.push(name)
  }
  assert.deepEqual(left, [])
})

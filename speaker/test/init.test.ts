import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { openStore, WrongPassword } from '../store.ts'

const password = 'a good owner password'
const init = join(import.meta.dirname, '..', '..', 'init.ts')

const freePort = () =>
  new Promise<number>((done) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => done(port))
    })
  })

async function scratch(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'speaker-init-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const run = (args: string[], input = `${password}\n`) =>
  spawnSync(process.execPath, [init, 'speaker', '--yes', '--no-start', '--password-stdin', ...args], {
    input,
    encoding: 'utf8',
  })
const where = (dir: string) => [
  '--data-dir',
  join(dir, 'data'),
  '--env-path',
  join(dir, '.env'),
  '--address',
  '192.168.1.10',
]
const ports = async () => {
  const [port, proxyPort, sshPort] = [await freePort(), await freePort(), await freePort()]
  return {
    port,
    proxyPort,
    sshPort,
    args: ['--port', `${port}`, '--proxy-port', `${proxyPort}`, '--ssh-port', `${sshPort}`],
  }
}

test('init speaker writes .env and an encrypted store that only the chosen password opens', async (t) => {
  const dir = await scratch(t)
  const { port, proxyPort, sshPort, args } = await ports()
  const result = run([...where(dir), ...args])
  assert.equal(result.status, 0, result.stderr + result.stdout)

  const env = (await readFile(join(dir, '.env'), 'utf8')).split('\n')
  for (const line of [
    `DATA_DIR=${join(dir, 'data')}`,
    `PORT=${port}`,
    `PUBLIC_URL=http://192.168.1.10:${port}`,
    `PROXY_PORT=${proxyPort}`,
    `SSH_PORT=${sshPort}`,
  ])
    assert.ok(env.includes(line), `${line} is missing from ${env.join('\n')}`)
  assert.ok(!env.some((line) => line.startsWith('TRUSTED_PROXY')))
  assert.equal((await stat(join(dir, '.env'))).mode & 0o777, 0o600)
  assert.equal((await stat(join(dir, 'data'))).mode & 0o777, 0o700)

  const store = await openStore(join(dir, 'data', 'store.json'), password)
  assert.match(store.vault.ssh.public, /^ssh-ed25519 /)
  await assert.rejects(openStore(join(dir, 'data', 'store.json'), 'another password'), WrongPassword)
})

test('behind a reverse proxy init sets TRUSTED_PROXY and the browser URL, and reminds about the open ports', async (t) => {
  const dir = await scratch(t)
  const result = run([
    ...where(dir),
    ...(await ports()).args,
    ...['--public-url', 'https://speaker.example.com', '--trusted-proxy', '172.18.0.2'],
  ])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /timeout above 120 s/)
  const env = await readFile(join(dir, '.env'), 'utf8')
  assert.match(env, /^PUBLIC_URL=https:\/\/speaker\.example\.com$/m)
  assert.match(env, /^TRUSTED_PROXY=172\.18\.0\.2$/m)
})

test('init stops with the fix when a port is taken, and writes nothing', async (t) => {
  const dir = await scratch(t)
  const taken = createServer().listen(0, '0.0.0.0')
  t.after(() => taken.close())
  await new Promise((done) => taken.once('listening', done))
  const { port } = taken.address() as { port: number }
  const result = run([...where(dir), '--port', `${port}`])
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`Web port ${port} is already in use. Fix: choose another with --port`))
  await assert.rejects(stat(join(dir, '.env')))
  await assert.rejects(stat(join(dir, 'data')))
})

test('init speaker --start signs in once with the owner password, so speaker is unlocked', async (t) => {
  const dir = await scratch(t)
  const { port, args } = await ports()
  const result = spawnSync(
    process.execPath,
    [init, 'speaker', '--yes', '--start', '--password-stdin', ...where(dir), ...args],
    { input: `${password}\n`, encoding: 'utf8' },
  )
  const pid = Number(/pid (\d+)/.exec(result.stdout)?.[1])
  if (pid) t.after(() => process.kill(pid))
  assert.equal(result.status, 0, result.stderr + result.stdout)
  // Locked speaker answers 503 to every API call; an unlocked one asks for credentials instead.
  const me = await fetch(`http://127.0.0.1:${port}/_speaker/me`)
  assert.notEqual(me.status, 503)
})

test('init refuses a data directory that already has a key store, and says how to proceed', async (t) => {
  const dir = await scratch(t)
  const { args } = await ports()
  assert.equal(run([...where(dir), ...args]).status, 0)
  await rm(join(dir, '.env'))
  const again = run([...where(dir), ...(await ports()).args])
  assert.equal(again.status, 1)
  assert.match(
    again.stderr,
    /already has a key store \(store\.json\).*choose another data directory, or keep using that install/,
  )
})

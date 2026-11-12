import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { createApp, readConfig } from '../server.ts'
import { setOwnerPassword } from './owner.ts'

const run = promisify(execFile)
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const agent = { authorization: 'Bearer agent-token' }

test('an approved SSH request returns a certificate limited to its principal, window and options', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'speaker-ssh-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ca', '-f', join(dir, 'ca')])
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'agent', '-f', join(dir, 'agent')])
  await writeFile(join(dir, 'ssh-hosts.json'), JSON.stringify({ nas: { hostname: 'nas.lan', users: ['raist'] } }))
  const app = await createApp(
    readConfig({
      DATA_DIR: dir,
      PUBLIC_URL: 'http://localhost',
      SSH_CA_KEY: join(dir, 'ca'),
      SSH_MAX_DURATION: '1h',
    }),
  )
  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init }))
  const owner = { cookie: await setOwnerPassword(call), origin: 'http://localhost' }
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    call(path, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const enrolled = await post('/_speaker/agents', {
    label: 'ops',
    agent: 'Test LLM · Test app',
    tokenHash: sha('agent-token'),
  })
  const { id: agentId } = (await enrolled.json()) as { id: string }

  const keyOnly = (line: string) => line.split(' ').slice(0, 2).join(' ')
  const served = await (await call('/_speaker/ssh/ca.pub')).text()
  assert.equal(keyOnly(served.trim()), keyOnly(await readFile(join(dir, 'ca.pub'), 'utf8')))
  const publicKey = (await readFile(join(dir, 'agent.pub'), 'utf8')).trim()
  const ask = (body: object) =>
    post(
      '/_speaker/ssh',
      { host: 'nas', user: 'raist', publicKey, reason: 'check disks', duration: '30m', ...body },
      agent,
    )
  assert.equal((await ask({ user: 'root' })).status, 400)
  assert.equal((await ask({ host: 'other' })).status, 400)
  assert.equal((await ask({ duration: '1d' })).status, 400)
  assert.equal((await ask({ publicKey: 'ssh-ed25519 AAAAnotakey' })).status, 400)

  const made = await ask({ sourceAddress: '10.0.0.0/24' })
  assert.equal(made.status, 201)
  const { id } = (await made.json()) as { id: string; status: string }
  const page = await (await call('/admin', { headers: owner })).text()
  assert.ok(page.includes('raist@nas.lan:22') && page.includes('SHA256:'))

  assert.equal((await post(`/admin/api/requests/${id}/approve`, { duration: '1d' }, owner)).status, 400)
  assert.equal((await post(`/admin/api/requests/${id}/approve`, { duration: '30m' }, owner)).status, 200)
  const issued = (
    (await (await call('/_speaker/me', { headers: agent })).json()) as {
      requests: {
        id: string
        status: string
        granted: string[]
        certificate: string
        expiresAt: string
        ssh: { hostname: string; port: number; user: string }
      }[]
    }
  ).requests.find((request) => request.id === id)
  assert.ok(issued)
  assert.deepEqual([issued.status, issued.granted], ['decided', ['ssh-cert:raist@nas']])
  assert.deepEqual(issued.ssh, { hostname: 'nas.lan', port: 22, user: 'raist' })
  const remaining = Date.parse(issued.expiresAt) - Date.now()
  assert.ok(remaining > 29 * 60_000 && remaining <= 30 * 60_000)

  await writeFile(join(dir, 'agent-cert.pub'), `${issued.certificate}\n`)
  const { stdout } = await run('ssh-keygen', ['-L', '-f', join(dir, 'agent-cert.pub')])
  assert.match(stdout, /Type: ssh-ed25519-cert-v01@openssh.com user certificate/)
  assert.match(stdout, new RegExp(`Key ID: "speaker:${id}:${agentId}"`))
  assert.match(stdout, /Principals: \n\s+raist@nas\n/)
  assert.match(stdout, /source-address 10\.0\.0\.0\/24/)
  assert.match(stdout, /permit-pty/)
  assert.doesNotMatch(stdout, /permit-agent-forwarding|permit-port-forwarding|permit-X11|permit-user-rc/)
  const [, from, to] = stdout.match(/Valid: from (\S+) to (\S+)/) ?? []
  const minutes = (Date.parse(to) - Date.parse(from)) / 60_000
  assert.equal(minutes, 31, 'one minute of clock-skew allowance plus the approved 30 minutes')
})

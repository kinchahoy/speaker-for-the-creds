// SSH and folders: targets and shares (plain settings), speaker's ssh-agent, and the jump server, a non-root stock
// `sshd` that runs only while an SSH or over-SSH folder grant is active. Its forced command is relay.ts, which talks
// to speaker over a unix socket; speaker decides what each session may do and can end it at any time.
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { existsSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context, Hono } from 'hono'
import writeFile from 'write-file-atomic'
import { z } from 'zod'
import type { FromSpeaker, ToSpeaker } from './relay.ts'

const run = promisify(execFile)
const sshd = '/usr/sbin/sshd'
const relayScript = fileURLToPath(new URL('./relay.ts', import.meta.url))
const aliasSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'A name uses letters, numbers, - and _')
const targetSchema = z.object({
  host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:_-]*$/, 'Use a host name or IP address'),
  port: z.number().int().min(1).max(65535),
  account: z.string().regex(/^[a-z_][a-z0-9_.-]*\$?$/i, 'Use a plain login name'),
  // The pinned host key, `ssh-ed25519 AAAA…`.
  hostKey: z.string(),
  // The address list for `from=` in the target's authorized_keys.
  from: z.string().regex(/^[0-9A-Za-z.:/*?!_-]+(,[0-9A-Za-z.:/*?!_-]+)*$/, 'Use comma-separated addresses'),
  // Whether `sudo -n true` succeeded when the target was added, and the account's home directory.
  sudo: z.boolean(),
  home: z.string(),
  // The target's sftp-server, probed when the target was added.
  sftp: z.string().optional(),
})
const shareSchema = z.object({
  target: aliasSchema,
  path: z.string().regex(/^\/[^\0\r\n]*$/, 'Use an absolute path on the target'),
  delivery: z.enum(['vm', 'ssh', 'both']),
})
const settingsSchema = z.object({
  targets: z.record(aliasSchema, targetSchema).default({}),
  shares: z.record(aliasSchema, shareSchema).default({}),
})
export type Target = z.infer<typeof targetSchema>
export type Share = z.infer<typeof shareSchema>

// A mistake in what the owner entered: shown on the Setup page, not a server fault.
class SetupError extends Error {}
const sh = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`)
const targetOf = (item: string) => /^ssh:([a-zA-Z0-9_-]+)$/.exec(item)?.[1]
const shareOf = (item: string) => {
  const [, name, rw] = /^folder:([a-zA-Z0-9_-]+)(:rw)?$/.exec(item) ?? []
  return name ? { name, rw: Boolean(rw) } : undefined
}
const keyBlob = (key: string) => key.split(/\s+/).slice(0, 2).join(' ')
export const fingerprint = (key: string) =>
  `SHA256:${createHash('sha256')
    .update(Buffer.from(key.split(/\s+/)[1], 'base64'))
    .digest('base64')
    .replace(/=+$/, '')}`
// OpenSSH's expiry-time: a UTC time as YYYYMMDDHHMMSSZ.
const expiryTime = (ms: number) => new Date(ms).toISOString().replace(/[-:T]|\.\d{3}/g, '')

type Env = {
  // SSH_PORT; without it SSH and over-SSH folders are off.
  port: number | undefined
  dataDir: string
  agent(id: string): { id: string; sshKey?: string; source: string } | undefined
  // Every active grant.
  grants(): { id: string; agentId: string; item: string; expiresAt: string | null }[]
  // Whether the agent's sandbox host can mount folders itself (VM mount).
  mountable(agentId: string): boolean
  audit(event: string, fields: Record<string, unknown>): void
  // Applies clock-driven expiry now.
  expire(): void
}
type Session = {
  id: string
  agent: string
  socket: Socket
  source: string
  started: number
  // The grant item the session runs on, known once it names a target or share.
  item?: string
  grant?: string
  what: string
  fields: Record<string, unknown>
  code?: number
  why?: string
  logged: boolean
}
export type SshSetup = {
  enabled: boolean
  port?: number
  publicKey?: string
  error?: string
  targets: Record<string, Target & { line: string; fingerprint: string }>
  shares: Record<string, Share>
}

const probeScript = [
  'id -un',
  'echo "home=$HOME"',
  'sudo -n true >/dev/null 2>&1 && echo sudo=yes',
  'for p in "$(command -v sftp-server)" /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/openssh/sftp-server /usr/libexec/sftp-server /usr/lib64/ssh/sftp-server /usr/lib/sftp-server /usr/local/libexec/sftp-server; do [ -x "$p" ] && echo "sftp=$p" && break; done',
].join('; ')

export async function createJump(env: Env) {
  const settingsFile = join(env.dataDir, 'ssh.json')
  const settings = settingsSchema.parse(JSON.parse(await readFile(settingsFile, 'utf8').catch(() => '{}')))
  const persist = () => writeFile(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 })
  const login = userInfo().username
  const sessions = new Map<string, Session>()
  const enabled = env.port !== undefined
  // Runtime state, all under one private temporary directory (mode 700) made when speaker unlocks. It holds the
  // ssh-agent socket, public keys and the jump server's per-start host key; speaker's private key never touches it.
  let dir = ''
  let publicKey = ''
  let agentProcess: ChildProcess | undefined
  let relayServer: Server | undefined
  let jumpProcess: ChildProcess | undefined
  let hostKey = ''
  let timer: NodeJS.Timeout | undefined
  const path = (name: string) => join(dir, name)
  const cleanup = () => {
    jumpProcess?.kill()
    agentProcess?.kill()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }

  // --- Speaker's key: a stock ssh-agent holds it; nothing else sees it. ---
  async function start(key: { private: string; public: string }) {
    if (!enabled || dir) return
    dir = await mkdtemp(join(tmpdir(), 'speaker-'))
    process.once('exit', cleanup)
    publicKey = key.public
    await writeFile(path('speaker.pub'), `${publicKey}\n`)
    agentProcess = spawn('ssh-agent', ['-D', '-a', path('agent.sock')], { stdio: 'ignore' })
    for (let i = 0; i < 40 && !existsSync(path('agent.sock')); i++) await sleep(50)
    const add = run('ssh-add', ['-'], { env: { ...process.env, SSH_AUTH_SOCK: path('agent.sock') } })
    add.child.stdin?.end(key.private)
    await add.catch((error: Error) => {
      throw new Error(`ssh-agent refused speaker's key: ${error.message}`)
    })
    await writeKnownHosts()
    relayServer = createServer(onRelay).listen(path('relay.sock'))
  }

  // The system ssh client to a target, authenticating through speaker's ssh-agent with the target's pinned host key.
  const writeKnownHosts = (extra: Record<string, Target> = {}) =>
    writeFile(
      path('known_hosts'),
      `${Object.entries({ ...settings.targets, ...extra })
        .map(([alias, target]) => `${alias} ${target.hostKey}`)
        .join('\n')}\n`,
    )
  const sshArgs = (alias: string, target: Target) => [
    '-F',
    '/dev/null',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    `IdentityFile=${path('speaker.pub')}`,
    '-o',
    `IdentityAgent=${path('agent.sock')}`,
    '-o',
    `UserKnownHostsFile=${path('known_hosts')}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `HostKeyAlias=${alias}`,
    '-o',
    'ConnectTimeout=10',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ControlPath=none',
    '-o',
    'ClearAllForwardings=yes',
    '-p',
    String(target.port),
    '-l',
    target.account,
    target.host,
    // Everything after `--` is the remote command, never an option of the local ssh.
    '--',
  ]
  async function onTarget(alias: string, target: Target, command: string) {
    if (!dir) throw new SetupError('Speaker is locked or SSH is off')
    await writeKnownHosts({ [alias]: target })
    try {
      return (await run('ssh', [...sshArgs(alias, target), command], { timeout: 30_000 })).stdout
    } catch (error) {
      const { stderr } = error as { stderr?: string }
      throw new SetupError(
        `Could not run a command as ${target.account}@${target.host}:${target.port}: ${stderr?.trim() || (error as Error).message}`,
      )
    }
  }
  const authorizedLine = (target: Target) => `from="${target.from}",restrict ${publicKey}`

  // --- Targets and shares (Setup) ---
  async function scanHostKey(host: string, port: number) {
    const { stdout } = await run('ssh-keyscan', ['-T', '5', '-p', String(port), '-t', 'ed25519,ecdsa,rsa', host]).catch(
      (error: Error) => {
        throw new SetupError(`Could not read the host key of ${host}:${port}: ${error.message}`)
      },
    )
    const keys = stdout
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(' ').slice(1, 3).join(' '))
    const key = ['ssh-ed25519', 'ecdsa-', 'ssh-rsa'].map((kind) => keys.find((k) => k.startsWith(kind))).find(Boolean)
    if (!key) throw new SetupError(`Could not read the host key of ${host}:${port}: no key offered`)
    return key
  }
  // The address this machine uses to reach the host: the natural `from=` for the target.
  const outgoingAddress = (host: string, port: number) =>
    new Promise<string>((done, fail) => {
      const socket = createSocket(host.includes(':') ? 'udp6' : 'udp4')
      socket.once('error', (error) => fail(new SetupError(`Cannot route to ${host}: ${error.message}`)))
      socket.connect(port, host, () => {
        const { address } = socket.address()
        socket.close()
        done(address)
      })
    })
  async function addTarget(form: Record<string, unknown>) {
    const input = z
      .object({
        alias: aliasSchema,
        host: targetSchema.shape.host,
        port: z.coerce.number().pipe(targetSchema.shape.port),
        account: targetSchema.shape.account,
        from: z.string().trim().optional(),
        sftp: z.string().trim().optional(),
        confirmRoot: z.literal('on').optional(),
      })
      .safeParse(form)
    if (!input.success) throw new SetupError(input.error.issues[0].message)
    const { alias, host, port, account, from, sftp, confirmRoot } = input.data
    if (!enabled) throw new SetupError('SSH is off: set SSH_PORT and restart speaker')
    if (Object.hasOwn(settings.targets, alias)) throw new SetupError(`Target ${alias} exists; delete it first`)
    if (account === 'root' && !confirmRoot)
      throw new SetupError('Refused: root has no limits. Tick "I understand" to use root anyway')
    const found = await scanHostKey(host, port)
    const target: Target = {
      host,
      port,
      account,
      hostKey: found,
      from: from || (await outgoingAddress(host, port)),
      sudo: false,
      home: '',
    }
    let output: string
    try {
      output = await onTarget(alias, target, `sh -c ${sh(probeScript)}`)
    } catch (error) {
      throw new SetupError(
        `${(error as Error).message}. Add this line to that account's authorized_keys, then try again: ${authorizedLine(target)}`,
      )
    }
    const lines = output.split('\n')
    if (lines[0] !== account) throw new SetupError(`Logged in as ${lines[0]}, not ${account}`)
    target.home = lines.find((line) => line.startsWith('home='))?.slice(5) ?? ''
    target.sudo = lines.includes('sudo=yes')
    target.sftp = sftp || lines.find((line) => line.startsWith('sftp='))?.slice(5)
    settings.targets[alias] = target
    await persist()
    env.audit('ssh_target_added', { target: alias, host, port, account, sudo: target.sudo, sftp: target.sftp ?? null })
  }
  async function setFrom(form: Record<string, unknown>) {
    const input = z.object({ alias: aliasSchema, from: targetSchema.shape.from }).safeParse(form)
    if (!input.success) throw new SetupError(input.error.issues[0].message)
    const target = settings.targets[input.data.alias]
    if (!target) throw new SetupError('Unknown target')
    target.from = input.data.from
    await persist()
  }
  async function removeTarget(alias: string) {
    if (!Object.hasOwn(settings.targets, alias)) throw new SetupError('Unknown target')
    delete settings.targets[alias]
    for (const [name, share] of Object.entries(settings.shares))
      if (share.target === alias) delete settings.shares[name]
    await persist()
    env.audit('ssh_target_removed', { target: alias })
  }
  async function saveShare(form: Record<string, unknown>) {
    const input = shareSchema.extend({ name: aliasSchema }).safeParse(form)
    if (!input.success) throw new SetupError(input.error.issues[0].message)
    const { name, ...share } = input.data
    const target = settings.targets[share.target]
    if (!target) throw new SetupError(`There is no target ${share.target}`)
    await onTarget(share.target, target, `test -d ${sh(share.path)}`).catch(() => {
      throw new SetupError(`${share.path} is not a directory on ${share.target} for ${target.account}`)
    })
    settings.shares[name] = share
    await persist()
    env.audit('ssh_share_saved', { share: name, target: share.target, path: share.path, delivery: share.delivery })
  }
  async function removeShare(name: string) {
    if (!Object.hasOwn(settings.shares, name)) throw new SetupError('Unknown share')
    delete settings.shares[name]
    await persist()
    env.audit('ssh_share_removed', { share: name })
  }

  // --- What an item means for an agent ---
  // `vm` when the agent's sandbox host mounts it, else `ssh` when the share allows that.
  const deliveryOf = (agentId: string, share: Share) =>
    share.delivery !== 'ssh' && env.mountable(agentId) ? 'vm' : share.delivery !== 'vm' ? 'ssh' : undefined
  // Why an ssh: or folder: item cannot be delivered to this agent, or undefined when it can.
  function unavailable(agentId: string, item: string) {
    const target = targetOf(item)
    if (target !== undefined)
      return !enabled
        ? 'SSH is off on this speaker'
        : settings.targets[target]
          ? undefined
          : `there is no target named ${target}`
    const folder = shareOf(item)
    if (!folder) return undefined
    const share = settings.shares[folder.name]
    if (!share) return `there is no share named ${folder.name}`
    const how = deliveryOf(agentId, share)
    if (how === 'vm') return undefined
    if (how === undefined) return `${folder.name} is not delivered over SSH`
    return !enabled
      ? 'SSH is off on this speaker'
      : settings.targets[share.target]?.sftp
        ? undefined
        : `the target of ${folder.name} has no sftp-server`
  }
  const overSsh = (grant: { agentId: string; item: string }) => {
    const folder = shareOf(grant.item)
    if (!folder) return targetOf(grant.item) !== undefined && unavailable(grant.agentId, grant.item) === undefined
    const share = settings.shares[folder.name]
    return Boolean(
      share && unavailable(grant.agentId, grant.item) === undefined && deliveryOf(grant.agentId, share) === 'ssh',
    )
  }
  const sshGrants = () => env.grants().filter(overSsh)
  // The card's view of an item: what it reaches, and a warning when it is broader than it looks.
  function describe(agentId: string, item: string) {
    const alias = targetOf(item)
    if (alias !== undefined) {
      const target = settings.targets[alias]
      if (!target) return undefined
      return {
        text: `commands as ${target.account}@${target.host}:${target.port}`,
        warning: target.sudo
          ? 'passwordless sudo works for this account'
          : target.account === 'root'
            ? 'root account'
            : undefined,
      }
    }
    const folder = shareOf(item)
    const share = folder && settings.shares[folder.name]
    if (!folder || !share) return undefined
    const target = settings.targets[share.target]
    const how = deliveryOf(agentId, share)
    return {
      text: `${share.target}:${share.path} · ${folder.rw ? 'read-write' : 'read-only'} · ${how === 'vm' ? 'VM mount' : 'over SSH'}`,
      warning: target?.home && target.home === share.path ? "this share is the account's home directory" : undefined,
    }
  }
  const setup = (error?: string): SshSetup => ({
    enabled,
    port: env.port,
    publicKey: publicKey || undefined,
    error,
    targets: Object.fromEntries(
      Object.entries(settings.targets).map(([alias, target]) => [
        alias,
        { ...target, line: authorizedLine(target), fingerprint: fingerprint(target.hostKey) },
      ]),
    ),
    shares: settings.shares,
  })

  // --- What /me tells an agent ---
  function commands(agentId: string, host: string) {
    if (!hostKey) return []
    const known = `[${host}]:${env.port} ${hostKey}`
    const options = `-o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o 'KnownHostsCommand=/bin/echo "${known}"'`
    const at = `${login}@${host.includes(':') ? `[${host}]` : host}`
    const key = '-i <key>'
    return sshGrants()
      .filter((grant) => grant.agentId === agentId)
      .map(({ item, expiresAt }) => {
        const alias = targetOf(item)
        if (alias !== undefined)
          return {
            item,
            expiresAt,
            commands: [
              `ssh -p ${env.port} ${key} ${options} ${login}@${host} ${alias} '<command>'`,
              `scp -P ${env.port} ${key} ${options} <file> ${at}:${alias}/<absolute path on ${alias}>`,
              `sftp -P ${env.port} ${key} ${options} ${at}:${alias}/<absolute path on ${alias}>`,
            ],
          }
        const share = shareOf(item)?.name ?? ''
        return {
          item,
          expiresAt,
          commands: [
            `sshfs -p ${env.port} -o IdentityFile=<key> -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o 'KnownHostsCommand=/bin/echo "${known}"' ${at}:${share} <mountpoint>`,
            `scp -P ${env.port} ${key} ${options} <file> ${at}:${share}/<path>`,
            `sftp -P ${env.port} ${key} ${options} ${at}:${share}/<path>`,
          ],
        }
      })
  }

  // --- The jump server ---
  const relayCommand = (agentId: string) =>
    [process.execPath, relayScript, path('relay.sock'), agentId].map(sh).join(' ').replaceAll('"', '\\"')
  async function writeKeys(grants: ReturnType<typeof sshGrants>) {
    const lines: string[] = []
    for (const agentId of new Set(grants.map((grant) => grant.agentId))) {
      const agent = env.agent(agentId)
      if (!agent?.sshKey) continue
      const ends = grants.filter((grant) => grant.agentId === agentId).map((grant) => grant.expiresAt)
      const last = ends.includes(null) ? undefined : Math.max(...ends.map((end) => Date.parse(end ?? '')))
      lines.push(
        `restrict,from="${agent.source}",command="${relayCommand(agentId)}"${last === undefined ? '' : `,expiry-time="${expiryTime(last)}"`} ${keyBlob(agent.sshKey)}`,
      )
    }
    await writeFile(path('authorized_keys'), `${lines.join('\n')}\n`)
  }
  const listening = () =>
    new Promise<boolean>((done) => {
      const probe = connect(env.port as number, '127.0.0.1')
      probe.once('connect', () => {
        probe.destroy()
        done(true)
      })
      probe.once('error', () => done(false))
    })
  async function startJump() {
    if (jumpProcess) return
    await rm(path('host_key'), { force: true })
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path('host_key')])
    await writeFile(
      path('sshd_config'),
      [
        `Port ${env.port}`,
        `HostKey ${path('host_key')}`,
        'PidFile none',
        `AuthorizedKeysFile ${path('authorized_keys')}`,
        // authorized_keys lives in the temporary directory, outside a home directory, which StrictModes would reject.
        'StrictModes no',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'UsePAM no',
        'AuthenticationMethods publickey',
        `AllowUsers ${login}`,
        'PermitTTY no',
        'AllowTcpForwarding no',
        'X11Forwarding no',
        'AllowAgentForwarding no',
        'PermitUserRC no',
        'Subsystem sftp internal-sftp',
        'MaxAuthTries 3',
        'LoginGraceTime 20',
        'ClientAliveInterval 30',
        'LogLevel ERROR',
      ].join('\n'),
    )
    const child = spawn(sshd, ['-D', '-e', '-f', path('sshd_config')], { stdio: ['ignore', 'inherit', 'inherit'] })
    let failed: string | undefined
    child.once('exit', (code) => {
      failed = `sshd exited with code ${code}`
      if (jumpProcess === child) jumpProcess = undefined
    })
    child.once('error', (error) => {
      failed = error.message
    })
    jumpProcess = child
    for (let i = 0; i < 100 && !(await listening()); i++) {
      if (failed) throw new Error(`The SSH jump server did not start on port ${env.port}: ${failed}`)
      await sleep(50)
    }
    hostKey = keyBlob(await readFile(path('host_key.pub'), 'utf8'))
    env.audit('ssh_jump_started', { port: env.port })
  }
  async function stopJump() {
    const child = jumpProcess
    if (!child) return
    jumpProcess = undefined
    hostKey = ''
    const exited = new Promise((done) => child.once('exit', done))
    child.kill()
    await exited
    env.audit('ssh_jump_stopped', {})
  }

  // Brings the jump server in line with the grants: keys rewritten, started or stopped, stale sessions ended.
  let chain: Promise<unknown> = Promise.resolve()
  const sync = () => {
    const next = chain
      .catch(() => undefined)
      .then(apply)
      .catch((error: Error) => {
        env.audit('ssh_sync_failed', { error: error.message })
        throw error
      })
    chain = next
    return next
  }
  async function apply() {
    if (!dir) return
    const live = sshGrants()
    for (const session of [...sessions.values()])
      if (!live.some((grant) => grant.agentId === session.agent && (!session.item || grant.item === session.item)))
        end(session, 'its grant ended')
    clearTimeout(timer)
    if (!live.length) return stopJump()
    await writeKeys(live)
    await startJump()
    // Run the clock at the earliest end, so a session does not outlive its grant by a sweep interval.
    const next = Math.min(...live.map((grant) => (grant.expiresAt === null ? Infinity : Date.parse(grant.expiresAt))))
    if (next !== Infinity) timer = setTimeout(env.expire, Math.max(next - Date.now(), 0) + 100).unref()
  }

  // --- Sessions: one relay connection each ---
  function end(session: Session, why: string) {
    session.why ??= why
    session.socket.write(`${JSON.stringify({ type: 'end', why } satisfies FromSpeaker)}\n`)
    session.socket.end()
    setTimeout(() => session.socket.destroy(), 1000).unref()
  }
  function onRelay(socket: Socket) {
    let session: Session | undefined
    const send = (message: FromSpeaker) => void socket.write(`${JSON.stringify(message)}\n`)
    const refuse = (message: string, fields: Record<string, unknown> = {}) => {
      env.audit('ssh_refused', { agent: session?.agent, source: session?.source, why: message, ...fields })
      send({ type: 'refused', message })
      socket.end()
    }
    const begin = (item: string, grant: string, what: string, fields: Record<string, unknown>) => {
      if (!session) return
      Object.assign(session, { item, grant, what, fields, logged: true })
      env.audit('ssh_session', {
        session: session.id,
        agent: session.agent,
        grant,
        fingerprint: fingerprint(env.agent(session.agent)?.sshKey ?? ''),
        source: session.source,
        ...fields,
      })
    }
    function onMessage(message: ToSpeaker) {
      if (message.type === 'start') {
        const agent = env.agent(message.agent)
        const grants = sshGrants().filter((grant) => grant.agentId === message.agent)
        const id = randomBytes(8).toString('hex')
        session = {
          id,
          agent: message.agent,
          socket,
          source: message.source,
          started: Date.now(),
          what: 'connecting',
          fields: {},
          logged: false,
        }
        if (!agent?.sshKey || !grants.length) return refuse('You have no active SSH or folder grant')
        sessions.set(id, session)
        if (message.command === 'internal-sftp') return send({ type: 'sftp' })
        const word = /^\S*/.exec(message.command)?.[0] ?? ''
        const rest = message.command.slice(word.length).replace(/^\s+/, '')
        if (word === 'rsync' || word === 'scp')
          return refuse(`${word} is not supported here; use sftp`, { command: message.command })
        if (!word) return refuse('Name a target and a command: ssh … <target> <command>')
        const grant = grants.find((g) => g.item === `ssh:${word}`)
        const target = settings.targets[word]
        if (!grant || !target) {
          const folder = grants.some((g) => shareOf(g.item)?.name === word)
          return refuse(
            folder ? 'A folder grant allows sftp only: use sftp, scp or sshfs' : `You have no SSH grant for "${word}"`,
            { command: message.command },
          )
        }
        if (!rest) return refuse('Give a command to run: interactive sessions are not available', { target: word })
        begin(grant.item, grant.id, `${word}: ${rest}`, { target: word, command: rest })
        return send({ type: 'run', argv: ['ssh', ...sshArgs(word, target), rest] })
      }
      if (!session) return socket.destroy()
      if (message.type === 'mount') {
        const grants = sshGrants().filter((grant) => grant.agentId === session?.agent)
        const folder =
          grants.find((g) => g.item === `folder:${message.name}:rw`) ??
          grants.find((g) => g.item === `folder:${message.name}`)
        const share = settings.shares[message.name]
        const sshGrant = grants.find((g) => g.item === `ssh:${message.name}`)
        // A share wins over a target of the same name.
        const alias = folder && share ? share.target : sshGrant ? message.name : undefined
        const target = alias === undefined ? undefined : settings.targets[alias]
        if (alias === undefined || !target)
          return void send({ type: 'refused', message: `You have no grant for "${message.name}"` })
        if (!target.sftp) return void send({ type: 'refused', message: `${alias} has no sftp-server` })
        const readOnly = folder && share ? !folder.item.endsWith(':rw') : false
        const argv = [
          'ssh',
          ...sshArgs(alias, target),
          folder && share ? `${target.sftp} -d ${sh(share.path)}${readOnly ? ' -R' : ''}` : target.sftp,
        ]
        const granted = (folder && share ? folder : sshGrant) as { id: string; item: string }
        begin(
          granted.item,
          granted.id,
          `sftp ${message.name}`,
          folder && share ? { share: message.name, target: alias, readOnly } : { target: alias },
        )
        return send({ type: 'mount', name: message.name, readOnly, absolute: !(folder && share), argv })
      }
      if (message.type === 'file')
        env.audit('ssh_file', {
          session: session.id,
          agent: session.agent,
          grant: session.grant,
          ...session.fields,
          op: message.op,
          path: message.path,
        })
      else if (message.type === 'refused')
        env.audit('ssh_refused', { session: session.id, agent: session.agent, ...session.fields, why: message.message })
      else if (message.type === 'exit') session.code = message.code
    }
    createInterface({ input: socket }).on('line', (line) => {
      try {
        onMessage(JSON.parse(line) as ToSpeaker)
      } catch (error) {
        env.audit('ssh_relay_failed', { error: (error as Error).message })
        socket.destroy()
      }
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      if (!session) return
      sessions.delete(session.id)
      if (session.logged)
        env.audit('ssh_session_end', {
          session: session.id,
          agent: session.agent,
          ...session.fields,
          code: session.code ?? null,
          why: session.why ?? (session.code === undefined ? 'disconnected' : 'finished'),
          ms: Date.now() - session.started,
        })
    })
  }

  // --- Admin routes (Setup forms and End) ---
  function routes(admin: Hono, fields: (c: Context) => Promise<Record<string, unknown>>, changed: () => void) {
    const guarded = (action: (form: Record<string, unknown>) => Promise<unknown>) => async (c: Context) => {
      try {
        await action(await fields(c))
        changed()
        return c.redirect('/admin?section=services', 303)
      } catch (error) {
        if (!(error instanceof SetupError)) throw error
        return c.redirect(`/admin?section=services&sshError=${encodeURIComponent(error.message.slice(0, 600))}`, 303)
      }
    }
    admin.post('/ssh/targets/add', guarded(addTarget))
    admin.post('/ssh/targets/from', guarded(setFrom))
    admin.post(
      '/ssh/targets/delete',
      guarded((form) => removeTarget(String(form.alias))),
    )
    admin.post('/ssh/shares/save', guarded(saveShare))
    admin.post(
      '/ssh/shares/delete',
      guarded((form) => removeShare(String(form.name))),
    )
    admin.post('/ssh/sessions/end', async (c) => {
      const session = sessions.get(String((await fields(c)).id))
      if (session) end(session, 'ended by the owner')
      return c.redirect('/admin', 303)
    })
  }

  return {
    enabled,
    start,
    sync,
    unavailable,
    overSsh,
    describe,
    setup,
    commands,
    routes,
    login,
    get hostKey() {
      return hostKey
    },
    sessions: () =>
      [...sessions.values()]
        .filter((session) => session.logged)
        .map(({ id, agent, what, started }) => ({ id, agent, what, started })),
    async stop() {
      clearTimeout(timer)
      for (const session of sessions.values()) end(session, 'speaker stopped')
      await stopJump()
      relayServer?.close()
      agentProcess?.kill()
      if (dir) rmSync(dir, { recursive: true, force: true })
      dir = ''
    },
  }
}
export type Jump = Awaited<ReturnType<typeof createJump>>

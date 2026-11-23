// SSH and folders: targets and shares (plain settings) and an in-process ssh2 jump server. Speaker listens on SSH_PORT
// only while an SSH or over-SSH folder grant is active, authenticates agents by public key and source address, and
// relays allowed exec and SFTP operations to targets with speaker's key held only in memory.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { Context, Hono } from 'hono'
import ssh2, {
  type Attributes,
  type Client,
  type ClientChannel,
  type Connection,
  type Server,
  type ServerChannel,
  type SFTPWrapper,
} from 'ssh2'
import writeFile from 'write-file-atomic'
import { z } from 'zod'
import type { Description } from './engine.ts'
import { type SessionState, sessionTable, transition } from './lifecycle.ts'

const { Client: SshClient, Server: SshServer, utils } = ssh2
const { SFTP } = createRequire(import.meta.url)('ssh2/lib/protocol/SFTP.js') as {
  SFTP: new (...args: unknown[]) => SFTPWrapper & { _init(): void; push(d: Buffer | null): void }
}
const { OPEN_MODE, STATUS_CODE } = utils.sftp
const emptyAttrs: Attributes = { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }

const aliasSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'A name uses letters, numbers, - and _')
const targetSchema = z.object({
  host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:_-]*$/, 'Use a host name or IP address'),
  port: z.number().int().min(1).max(65535),
  account: z.string().regex(/^[a-z_][a-z0-9_.-]*\$?$/i, 'Use a plain login name'),
  hostKey: z.string(),
  from: z.string().regex(/^[0-9A-Za-z.:/*?!_-]+(,[0-9A-Za-z.:/*?!_-]+)*$/, 'Use comma-separated addresses'),
  sudo: z.boolean(),
  home: z.string(),
  sftp: z.string().optional(),
})
const shareSchema = z.object({
  target: aliasSchema,
  path: z.string().regex(/^\/[^\0\r\n]*$/, 'Use an absolute path on the target'),
})
const settingsSchema = z.object({
  targets: z.record(aliasSchema, targetSchema).default({}),
  shares: z.record(aliasSchema, shareSchema).default({}),
})
export type Target = z.infer<typeof targetSchema>
export type Share = z.infer<typeof shareSchema>

class SetupError extends Error {}
const parsed = <T>(result: z.ZodSafeParseResult<T>) => {
  if (!result.success) throw new SetupError(result.error.issues[0].message)
  return result.data
}
const sh = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`)
const targetOf = (item: string) => /^ssh:([a-zA-Z0-9_-]+)$/.exec(item)?.[1]
const shareOf = (item: string) => {
  const [, name, rw] = /^folder:([a-zA-Z0-9_-]+)(:rw)?$/.exec(item) ?? []
  return name ? { name, rw: Boolean(rw) } : undefined
}
export const fingerprint = (key: string) =>
  `SHA256:${createHash('sha256')
    .update(Buffer.from(key.split(/\s+/)[1], 'base64'))
    .digest('base64')
    .replace(/=+$/, '')}`
const pathParts = (p: string) => {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return out
}

type Grant = { id: string; agentId: string; item: string; expiresAt: string | null }
type Env = {
  port: number
  dataDir: string
  agent(id: string): { id: string; sshKey?: string; source: string } | undefined
  grants(): Grant[]
  audit(event: string, fields: Record<string, unknown>): void
  expire(): void
}
type ActiveSession = {
  id: string
  state: SessionState
  agent: string
  source: string
  started: number
  grant?: string
  what: string
  fields: Record<string, unknown>
  code?: number
  why?: string
  close(why?: string): void
}
export type SshSetup = {
  port?: number
  publicKey?: string
  error?: string
  note?: string
  targets: Record<string, Target & { line: string; fingerprint: string }>
  shares: Record<string, Share>
}

const probeScript = [
  'id -un',
  'echo "home=$HOME"',
  'sudo -n true >/dev/null 2>&1 && echo sudo=yes',
  'for p in "$(command -v sftp-server)" /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/openssh/sftp-server /usr/libexec/sftp-server /usr/lib64/ssh/sftp-server /usr/lib/sftp-server /usr/local/libexec/sftp-server; do [ -x "$p" ] && echo "sftp=$p" && break; done',
].join('; ')

// Wraps an exec'd sftp-server channel in ssh2's SFTP client protocol handler (works even without Subsystem sftp).
function openSftpOnExec(client: Client, command: string): Promise<SFTPWrapper> {
  return new Promise((done, fail) => {
    client.exec(command, (err, stream: ClientChannel) => {
      if (err) return fail(err)
      const outgoing = { id: 0, state: 'open', window: 1 << 30, packetSize: 32768 }
      const shim = {
        _protocol: {
          _remoteIdentRaw: '',
          channelData(_id: number, chunk: Buffer) {
            outgoing.window = 1 << 30
            stream.write(chunk)
          },
          channelClose: () => stream.close(),
        },
      }
      const remote = new SFTP(shim, { type: 'session', incoming: { id: 0, state: 'open' }, outgoing })
      const onClose = () => fail(new Error('The target sftp-server closed unexpectedly'))
      remote
        .once('ready', () => {
          remote.off('error', fail).off('close', onClose)
          done(remote)
        })
        .once('error', fail)
        .once('close', onClose)
      stream.on('data', (c: Buffer) => remote.push(c))
      stream.on('end', () => remote.push(null))
      stream.on('close', () => remote.emit('close'))
      remote._init()
    })
  })
}

export async function createJump(env: Env) {
  const settingsFile = join(env.dataDir, 'ssh.json')
  const settings = settingsSchema.parse(
    existsSync(settingsFile) ? JSON.parse(await readFile(settingsFile, 'utf8')) : {},
  )
  const persist = () => writeFile(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 })
  const login = userInfo().username
  const sessions = new Map<string, ActiveSession>()
  let speakerKey: { private: string; public: string } | undefined
  let jump: { state: 'off' } | { state: 'on'; server: Server; hostKey: string } = { state: 'off' }
  let timer: NodeJS.Timeout | undefined

  async function start(key: { private: string; public: string }) {
    speakerKey = key
  }

  // --- Outbound ssh2 client to targets (speaker's private key stays in memory) ---
  function connectTarget(target: Target): Promise<Client> {
    if (!speakerKey) return Promise.reject(new SetupError('Speaker is locked'))
    const expected = Buffer.from(target.hostKey.split(/\s+/)[1] ?? '', 'base64')
    return new Promise((done, fail) => {
      const client = new SshClient()
      const onError = (err: Error) => {
        client.destroy()
        fail(err)
      }
      client
        .once('ready', () => (client.off('error', onError), done(client)))
        .once('error', onError)
        .connect({
          host: target.host,
          port: target.port,
          username: target.account,
          privateKey: speakerKey!.private,
          readyTimeout: 10_000,
          hostVerifier: (key: Buffer) => key.length === expected.length && timingSafeEqual(key, expected),
        })
    })
  }
  async function onTarget(target: Target, command: string) {
    if (!speakerKey) throw new SetupError('Speaker is locked')
    let client: Client | undefined
    try {
      client = await connectTarget(target)
      return await new Promise<string>((done, fail) => {
        const timeout = setTimeout(() => (client?.destroy(), fail(new Error('Timed out'))), 30_000)
        client!.exec(command, (err, stream) => {
          if (err) return (clearTimeout(timeout), fail(err))
          let stdout = '',
            stderr = ''
          stream.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
          stream.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
          stream.on('close', (code: number | null) => {
            clearTimeout(timeout)
            if (code !== 0) fail(new Error(stderr.trim() || `exit ${code ?? 'unknown'}`))
            else done(stdout)
          })
        })
      })
    } catch (error) {
      throw new SetupError(
        `Could not run a command as ${target.account}@${target.host}:${target.port}: ${(error as Error).message}`,
      )
    } finally {
      client?.end()
    }
  }
  const authorizedLine = (target: Target) => `from="${target.from}",restrict ${speakerKey?.public ?? ''}`

  // --- Targets and shares (Setup) ---
  function scanHostKey(host: string, port: number): Promise<string> {
    return new Promise((done, fail) => {
      const client = new SshClient()
      let found: string | undefined
      client
        .once('error', (err) => {
          client.destroy()
          if (!found) fail(new SetupError(`Could not read the host key of ${host}:${port}: ${err.message}`))
        })
        .once('close', () => {
          if (!found) fail(new SetupError(`Could not read the host key of ${host}:${port}: no key offered`))
        })
        .connect({
          host,
          port,
          username: 'probe',
          readyTimeout: 5000,
          algorithms: {
            serverHostKey: [
              'ssh-ed25519',
              'ecdsa-sha2-nistp256',
              'ecdsa-sha2-nistp384',
              'ecdsa-sha2-nistp521',
              'rsa-sha2-512',
              'rsa-sha2-256',
              'ssh-rsa',
            ],
          },
          hostVerifier: (key: Buffer) => {
            const k = utils.parseKey(key)
            if (!(k instanceof Error)) done((found = `${k.type} ${k.getPublicSSH().toString('base64')}`))
            return false
          },
        })
    })
  }
  const outgoingAddress = (host: string, port: number) =>
    new Promise<string>((done, fail) => {
      const socket = createSocket(host.includes(':') ? 'udp6' : 'udp4')
      socket.once('error', (error) => fail(new SetupError(`Cannot route to ${host}: ${error.message}`)))
      socket.connect(port, host, () => (done(socket.address().address), socket.close()))
    })
  async function probe(target: Target) {
    const lines = (await onTarget(target, `sh -c ${sh(probeScript)}`)).split('\n')
    if (lines[0] !== target.account) throw new SetupError(`Logged in as ${lines[0]}, not ${target.account}`)
    const value = (name: string) => lines.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1)
    return { home: value('home') ?? '', sudo: lines.includes('sudo=yes'), sftp: value('sftp') }
  }
  async function recheck(form: Record<string, unknown>) {
    const { alias } = parsed(z.object({ alias: aliasSchema }).safeParse(form))
    const target = settings.targets[alias]
    if (!target) throw new SetupError('Unknown target')
    const key = await scanHostKey(target.host, target.port)
    if (key !== target.hostKey)
      throw new SetupError(
        `The host key of ${alias} changed (pinned ${fingerprint(target.hostKey)}, now ${fingerprint(key)}). Delete the target and add it again only if you expect that`,
      )
    Object.assign(target, await probe(target))
    await persist()
    return `${alias}: reachable, host key matches${target.sudo ? ', passwordless sudo works' : ''}${target.sftp ? '' : ', no sftp-server'}`
  }
  async function addTarget(form: Record<string, unknown>) {
    const { alias, host, port, account, from, sftp, confirmRoot } = parsed(
      z
        .object({
          alias: aliasSchema,
          host: targetSchema.shape.host,
          port: z.coerce.number().pipe(targetSchema.shape.port),
          account: targetSchema.shape.account,
          from: z.string().trim().optional(),
          sftp: z.string().trim().optional(),
          confirmRoot: z.literal('on').optional(),
        })
        .safeParse(form),
    )
    if (Object.hasOwn(settings.targets, alias)) throw new SetupError(`Target ${alias} exists; delete it first`)
    if (account === 'root' && !confirmRoot)
      throw new SetupError('Refused: root has no limits. Tick "I understand" to use root anyway')
    const target: Target = {
      host,
      port,
      account,
      hostKey: await scanHostKey(host, port),
      from: from || (await outgoingAddress(host, port)),
      sudo: false,
      home: '',
    }
    Object.assign(
      target,
      await probe(target).catch((error: Error) => {
        throw new SetupError(
          error.message.startsWith('Could not run')
            ? `${error.message}. Add this line to that account's authorized_keys, then try again: ${authorizedLine(target)}`
            : error.message,
        )
      }),
    )
    if (sftp) target.sftp = sftp
    settings.targets[alias] = target
    await persist()
    env.audit('ssh_target_added', { target: alias, host, port, account, sudo: target.sudo, sftp: target.sftp ?? null })
  }
  async function setFrom(form: Record<string, unknown>) {
    const input = parsed(z.object({ alias: aliasSchema, from: targetSchema.shape.from }).safeParse(form))
    const target = settings.targets[input.alias]
    if (!target) throw new SetupError('Unknown target')
    target.from = input.from
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
    const { name, ...share } = parsed(shareSchema.extend({ name: aliasSchema }).safeParse(form))
    const target = settings.targets[share.target]
    if (!target) throw new SetupError(`There is no target ${share.target}`)
    await onTarget(target, `test -d ${sh(share.path)}`).catch(() => {
      throw new SetupError(`${share.path} is not a directory on ${share.target} for ${target.account}`)
    })
    settings.shares[name] = share
    await persist()
    env.audit('ssh_share_saved', { share: name, target: share.target, path: share.path })
  }
  async function removeShare(name: string) {
    if (!Object.hasOwn(settings.shares, name)) throw new SetupError('Unknown share')
    delete settings.shares[name]
    await persist()
    env.audit('ssh_share_removed', { share: name })
  }

  // --- What an item means for an agent ---
  function unknownName(item: string) {
    const target = targetOf(item)
    if (target !== undefined && !Object.hasOwn(settings.targets, target))
      return `There is no SSH target named ${target} that you can use.`
    const folder = shareOf(item)
    if (folder && !Object.hasOwn(settings.shares, folder.name))
      return `There is no folder named ${folder.name} that you can use.`
    return undefined
  }
  function unavailable(_agentId: string, item: string) {
    const target = targetOf(item)
    if (target !== undefined) return settings.targets[target] ? undefined : `there is no target named ${target}`
    const folder = shareOf(item)
    if (!folder) return undefined
    const share = settings.shares[folder.name]
    if (!share) return `there is no share named ${folder.name}`
    return settings.targets[share.target]?.sftp ? undefined : `the target of ${folder.name} has no sftp-server`
  }
  const overSsh = (grant: { agentId: string; item: string }) =>
    unavailable(grant.agentId, grant.item) === undefined &&
    (targetOf(grant.item) !== undefined || shareOf(grant.item) !== undefined)
  const sshGrants = (agentId?: string) =>
    env.grants().filter((grant) => overSsh(grant) && (agentId === undefined || grant.agentId === agentId))
  function describe(item: string): Description {
    const target = settings.targets[targetOf(item) ?? '']
    const at = (t: Target) => `${t.account}@${t.host}:${t.port}`
    if (target)
      return {
        text: `commands as ${at(target)}`,
        reach: [at(target)],
        risk: 'SSH',
        warning: target.sudo
          ? 'passwordless sudo works for this account'
          : target.account === 'root'
            ? 'root account'
            : undefined,
      }
    const folder = shareOf(item)
    const share = folder && settings.shares[folder.name]
    const host = share && settings.targets[share.target]
    if (!folder || !share || !host) return { text: 'no longer set up', reach: [] }
    return {
      text: `${share.target}:${share.path} · ${folder.rw ? 'read-write' : 'read-only'} · over SSH`,
      reach: [`${at(host)}:${share.path}`],
      risk: folder.rw ? 'read/write' : undefined,
      warning: host.home === share.path ? "this share is the account's home directory" : undefined,
    }
  }
  const setup = (error?: string, note?: string): SshSetup => ({
    port: env.port,
    publicKey: speakerKey?.public || undefined,
    error,
    note,
    targets: Object.fromEntries(
      Object.entries(settings.targets).map(([alias, target]) => [
        alias,
        { ...target, line: authorizedLine(target), fingerprint: fingerprint(target.hostKey) },
      ]),
    ),
    shares: settings.shares,
  })

  function commands(agentId: string, host: string) {
    if (jump.state === 'off') return []
    const known = `[${host}]:${env.port} ${jump.hostKey}`
    const options =
      '-o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=<known_hosts> -o StrictHostKeyChecking=yes'
    const knownHosts = { line: known, save: `printf '%s\\n' '${known}' > <known_hosts>` }
    const at = `${login}@${host.includes(':') ? `[${host}]` : host}`
    const port = `-P ${env.port} -i <key> ${options}`
    return sshGrants(agentId).map(({ item, expiresAt }) => {
      const alias = targetOf(item)
      const share = shareOf(item)?.name ?? ''
      return {
        item,
        expiresAt,
        knownHosts,
        commands:
          alias !== undefined
            ? [
                `ssh -p ${env.port} -i <key> ${options} ${login}@${host} ${alias} '<command>'`,
                `scp ${port} <file> ${at}:${alias}/<absolute path on ${alias}>`,
                `sftp ${port} ${at}:${alias}/<absolute path on ${alias}>`,
              ]
            : [
                `sshfs -p ${env.port} -o IdentityFile=<key> ${options} ${at}:${share} <mountpoint>`,
                `scp ${port} <file> ${at}:${share}/<path>`,
                `sftp ${port} ${at}:${share}/<path>`,
              ],
      }
    })
  }

  // --- Session lifecycle ---
  function createSession(agent: string, source: string, close: (why?: string) => void): ActiveSession {
    const session: ActiveSession = {
      id: randomBytes(8).toString('hex'),
      state: 'connecting',
      agent,
      source,
      started: Date.now(),
      what: 'connecting',
      fields: {},
      close,
    }
    sessions.set(session.id, session)
    return session
  }
  function beginSession(session: ActiveSession, grant: Grant, what: string, fields: Record<string, unknown>) {
    Object.assign(session, {
      state: transition('session', sessionTable, session.state, 'begin'),
      grant: grant.id,
      what,
      fields,
    })
    env.audit('ssh_session', {
      session: session.id,
      agent: session.agent,
      grant: grant.id,
      fingerprint: fingerprint(env.agent(session.agent)?.sshKey ?? ''),
      source: session.source,
      ...fields,
    })
  }
  function closeSession(session: ActiveSession) {
    if (!sessions.delete(session.id)) return
    const was = session.state
    session.state = transition('session', sessionTable, was, 'close')
    if (was === 'open')
      env.audit('ssh_session_end', {
        session: session.id,
        agent: session.agent,
        ...session.fields,
        code: session.code ?? null,
        why: session.why ?? (session.code === undefined ? 'disconnected' : 'finished'),
        ms: Date.now() - session.started,
      })
  }
  const end = (session: ActiveSession, why: string) => {
    session.why ??= why
    session.close(why)
    closeSession(session)
  }

  // --- Inbound ssh2 jump server ---
  function onConnection(conn: Connection, info: { ip: string }) {
    const source = info.ip.replace(/^::ffff:/, '')
    let agentId: string | undefined
    conn.on('error', () => undefined)
    conn.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey' || ctx.username !== login) return ctx.reject(['publickey'])
      for (const id of new Set(sshGrants().map((g) => g.agentId))) {
        const agent = env.agent(id)
        if (!agent?.sshKey || agent.source !== source) continue
        const key = utils.parseKey(agent.sshKey)
        if (key instanceof Error || ctx.key.algo !== key.type) continue
        const pub = key.getPublicSSH()
        if (ctx.key.data.length !== pub.length || !timingSafeEqual(ctx.key.data, pub)) continue
        if (!ctx.signature) return ctx.accept()
        if (ctx.blob && key.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ((agentId = id), ctx.accept())
      }
      ctx.reject(['publickey'])
    })

    conn.on('ready', () => {
      conn.on('session', (accept, reject) => {
        if (!agentId || !sshGrants(agentId).length) return reject()
        const who = agentId
        const sess = accept()
        const refuse = (ch: ServerChannel, message: string, fields: Record<string, unknown> = {}) => {
          env.audit('ssh_refused', { agent: who, source, why: message, ...fields })
          ch.stderr.write(`speaker: ${message}. Check GET /_speaker/catalog\n`)
          ch.exit(1)
          ch.close()
        }
        for (const ev of ['pty', 'x11', 'auth-agent'] as const) sess.on(ev, (_a: unknown, r: () => void) => r())
        sess.on('shell', (acceptShell) =>
          refuse(acceptShell(), 'Name a target and a command: ssh … <target> <command>'),
        )
        sess.on('exec', (acceptExec, _r, { command }) => {
          const ch = acceptExec()
          const grants = sshGrants(who)
          if (!grants.length) return refuse(ch, 'You have no active SSH or folder grant')
          const word = /^\S*/.exec(command)?.[0] ?? ''
          const rest = command.slice(word.length).replace(/^\s+/, '')
          if (word === 'rsync' || word === 'scp')
            return refuse(ch, `${word} is not supported here; use sftp`, { command })
          if (!word) return refuse(ch, 'Name a target and a command: ssh … <target> <command>')
          const grant = grants.find((g) => g.item === `ssh:${word}`)
          const target = settings.targets[word]
          if (!grant || !target)
            return refuse(
              ch,
              grants.some((g) => shareOf(g.item)?.name === word)
                ? 'A folder grant allows sftp only: use sftp, scp or sshfs'
                : `You have no SSH grant for "${word}"`,
              { command },
            )
          if (!rest)
            return refuse(ch, 'Give a command to run: interactive sessions are not available', { target: word })
          let targetClient: Client | undefined
          const active = createSession(who, source, (why) => {
            if (why) ch.stderr.write(`speaker: the session ended: ${why}. Check GET /_speaker/catalog\n`)
            targetClient?.destroy()
            ch.destroy()
            conn.end()
          })
          beginSession(active, grant, `${word}: ${rest}`, { target: word, command: rest })
          ch.on('close', () => (targetClient?.end(), closeSession(active)))
          connectTarget(target)
            .then((client) => {
              if (active.state === 'closed') return client.destroy()
              targetClient = client
              client.exec(rest, (err, remote) => {
                if (err) return (ch.stderr.write(`speaker: ${err.message}\n`), ch.exit(1), ch.close())
                ch.pipe(remote)
                remote.pipe(ch)
                remote.stderr.pipe(ch.stderr)
                remote.on('exit', (code: number | null) => ch.exit((active.code = code ?? 255)))
                remote.on('close', () => (ch.close(), client.end()))
              })
            })
            .catch((err: Error) => (ch.stderr.write(`speaker: ${err.message}\n`), ch.exit(1), ch.close()))
        })
        sess.on('sftp', (acceptSftp) => handleSftp(who, source, conn, acceptSftp()))
      })
    })
  }

  // --- Filtering SFTP server over ssh2's SFTPWrapper ---
  function handleSftp(agent: string, source: string, conn: Connection, sftp: SFTPWrapper) {
    type Mounted = { name: string; readOnly: boolean; absolute: boolean; root: string; remote: SFTPWrapper }
    let targetClient: Client | undefined
    let mounted: Mounted | undefined
    let mounting: Promise<Mounted | string> | undefined
    const active = createSession(agent, source, () => (targetClient?.destroy(), sftp.destroy(), conn.end()))
    sftp.on('end', () => ((active.code ??= 0), targetClient?.end(), sftp.end()))
    sftp.on('close', () => (targetClient?.end(), closeSession(active)))

    const replyErr = (id: number, err: Error & { code?: number }) =>
      sftp.status(id, typeof err.code === 'number' ? err.code : STATUS_CODE.FAILURE, err.message)
    const refuse = (id: number, message: string, code: number = STATUS_CODE.PERMISSION_DENIED) => {
      env.audit('ssh_refused', { session: active.id, agent, ...active.fields, why: message })
      sftp.status(id, code, message)
      return undefined
    }
    const virtual = (m: Mounted, p: string) => {
      if (m.absolute) return `/${m.name}${p === '/' ? '' : p}`
      const prefix = m.root.endsWith('/') ? m.root : `${m.root}/`
      return p === m.root ? `/${m.name}` : p.startsWith(prefix) ? `/${m.name}/${p.slice(prefix.length)}` : undefined
    }
    const remoteRealpath = (remote: SFTPWrapper, p: string) =>
      new Promise<string>((done, fail) => remote.realpath(p, (err, abs) => (err ? fail(err) : done(abs))))

    async function mount(name: string): Promise<Mounted | string> {
      const grants = sshGrants(agent)
      const folder =
        grants.find((g) => g.item === `folder:${name}:rw`) ?? grants.find((g) => g.item === `folder:${name}`)
      const share = folder && settings.shares[name]
      const sshGrant = grants.find((g) => g.item === `ssh:${name}`)
      const alias = share ? share.target : sshGrant ? name : undefined
      const target = alias === undefined ? undefined : settings.targets[alias]
      if (alias === undefined || !target) return `You have no grant for "${name}"`
      if (!target.sftp) return `${alias} has no sftp-server`
      const readOnly = share ? !folder.item.endsWith(':rw') : false
      const serverCmd = share ? `${target.sftp} -d ${sh(share.path)}${readOnly ? ' -R' : ''}` : target.sftp
      targetClient = await connectTarget(target)
      const remote = await openSftpOnExec(targetClient, serverCmd)
      const root = share ? await remoteRealpath(remote, '.') : '/'
      beginSession(
        active,
        (share ? folder : sshGrant) as Grant,
        `sftp ${name}`,
        share ? { share: name, target: alias, readOnly } : { target: alias },
      )
      remote.on('close', () => sftp.end())
      return (mounted = { name, readOnly, absolute: !share, root, remote })
    }

    async function checkPaths(
      id: number,
      rawPaths: string[],
      op: { name: string; write: boolean; follow: boolean },
    ): Promise<{ m: Mounted; targets: string[] } | undefined> {
      const comps = rawPaths.map(pathParts)
      if (comps.some((c) => !c.length))
        return op.name === 'realpath'
          ? (sftp.name(id, [{ filename: '/', longname: '/', attrs: emptyAttrs }]), undefined)
          : refuse(id, 'Name a share first: paths start with <share>/')
      const m = mounted ?? (await (mounting ??= mount(comps[0][0])))
      if (typeof m === 'string') return ((mounting = undefined), refuse(id, m))
      if (comps.some((c) => c[0] !== m.name)) return refuse(id, `One share per session: this one is ${m.name}`)
      if (op.write && m.readOnly) return refuse(id, 'This grant is read-only')
      const rests = comps.map((c) => c.slice(1))
      const onTargetPath = (rest: string[]) => (m.absolute ? `/${rest.join('/')}` : rest.join('/') || '.')
      if (!m.absolute && op.write && !op.follow && rests.some((r) => !r.length))
        return refuse(id, 'The share itself cannot be changed')
      if (!m.absolute) {
        const prefix = m.root.endsWith('/') ? m.root : `${m.root}/`
        for (const rest of rests) {
          const check = rest.length ? onTargetPath(op.follow ? rest : rest.slice(0, -1)) : '.'
          let resolved: string
          try {
            resolved = await remoteRealpath(m.remote, check)
          } catch (err) {
            return (replyErr(id, err as Error & { code?: number }), undefined)
          }
          if (!(resolved === m.root || resolved.startsWith(prefix))) return refuse(id, 'Outside the share')
        }
      }
      env.audit('ssh_file', {
        session: active.id,
        agent,
        ...active.fields,
        grant: active.grant,
        op: op.name,
        path: comps.map((c) => `/${c.join('/')}`).join(' -> '),
      })
      return { m, targets: rests.map(onTargetPath) }
    }

    const withPath = (
      id: number,
      paths: string[],
      op: { name: string; write: boolean; follow: boolean },
      fn: (m: Mounted, targets: string[]) => void,
    ) =>
      void checkPaths(id, paths, op)
        .then((res) => res && fn(res.m, res.targets))
        .catch((err: Error) => replyErr(id, err))
    const withHandle = (id: number, write: boolean, fn: (m: Mounted) => void) =>
      !mounted
        ? refuse(id, 'Name a share first: paths start with <share>/', STATUS_CODE.FAILURE)
        : write && mounted.readOnly
          ? refuse(id, 'This grant is read-only')
          : fn(mounted)
    const statusCb = (id: number) => (err?: Error | null) => (err ? replyErr(id, err) : sftp.status(id, STATUS_CODE.OK))
    const attrsCb = (id: number) => (err: Error | undefined, stats: Attributes) =>
      err ? replyErr(id, err) : sftp.attrs(id, stats)
    const handleCb = (id: number) => (err: Error | undefined, handle: Buffer) =>
      err ? replyErr(id, err) : sftp.handle(id, handle)

    sftp.on('REALPATH', (id, p) =>
      withPath(id, [p], { name: 'realpath', write: false, follow: true }, (m, [t]) =>
        m.remote.realpath(t, (err, abs) => {
          if (err) return replyErr(id, err)
          const shown = virtual(m, abs)
          return shown === undefined
            ? refuse(id, 'Outside the share')
            : sftp.name(id, [{ filename: shown, longname: shown, attrs: emptyAttrs }])
        }),
      ),
    )
    sftp.on('OPEN', (id, p, flags, attrs) => {
      const write = (flags & ~OPEN_MODE.READ) !== 0
      withPath(id, [p], { name: write ? 'open (write)' : 'open', write, follow: true }, (m, [t]) =>
        m.remote.open(t, flags, attrs, handleCb(id)),
      )
    })
    sftp.on('STAT', (id, p) =>
      withPath(id, [p], { name: 'stat', write: false, follow: true }, (m, [t]) => m.remote.stat(t, attrsCb(id))),
    )
    sftp.on('LSTAT', (id, p) =>
      withPath(id, [p], { name: 'lstat', write: false, follow: false }, (m, [t]) => m.remote.lstat(t, attrsCb(id))),
    )
    sftp.on('OPENDIR', (id, p) =>
      withPath(id, [p], { name: 'opendir', write: false, follow: true }, (m, [t]) => m.remote.opendir(t, handleCb(id))),
    )
    sftp.on('SETSTAT', (id, p, attrs) =>
      withPath(id, [p], { name: 'setstat', write: true, follow: true }, (m, [t]) =>
        m.remote.setstat(t, attrs, statusCb(id)),
      ),
    )
    sftp.on('READLINK', (id, p) =>
      withPath(id, [p], { name: 'readlink', write: false, follow: false }, (m, [t]) =>
        m.remote.readlink(t, (err, link) => {
          if (err) return replyErr(id, err)
          const shown = virtual(m, link) ?? link
          sftp.name(id, [{ filename: shown, longname: shown, attrs: emptyAttrs }])
        }),
      ),
    )
    sftp.on('REMOVE', (id, p) =>
      withPath(id, [p], { name: 'remove', write: true, follow: false }, (m, [t]) => m.remote.unlink(t, statusCb(id))),
    )
    sftp.on('MKDIR', (id, p, attrs) =>
      withPath(id, [p], { name: 'mkdir', write: true, follow: false }, (m, [t]) =>
        m.remote.mkdir(t, attrs, statusCb(id)),
      ),
    )
    sftp.on('RMDIR', (id, p) =>
      withPath(id, [p], { name: 'rmdir', write: true, follow: false }, (m, [t]) => m.remote.rmdir(t, statusCb(id))),
    )
    sftp.on('RENAME', (id, a, b) =>
      withPath(id, [a, b], { name: 'rename', write: true, follow: false }, (m, [x, y]) =>
        m.remote.rename(x, y, statusCb(id)),
      ),
    )
    sftp.on('CLOSE', (id, h) => withHandle(id, false, (m) => m.remote.close(h, statusCb(id))))
    sftp.on('READ', (id, h, off, len) =>
      withHandle(id, false, (m) =>
        m.remote.read(h, Buffer.allocUnsafe(len), 0, len, off, (err, n, buf) =>
          err ? replyErr(id, err) : n === 0 ? sftp.status(id, STATUS_CODE.EOF) : sftp.data(id, buf.subarray(0, n)),
        ),
      ),
    )
    sftp.on('WRITE', (id, h, off, data) =>
      withHandle(id, true, (m) => m.remote.write(h, data, 0, data.length, off, statusCb(id))),
    )
    sftp.on('FSTAT', (id, h) => withHandle(id, false, (m) => m.remote.fstat(h, attrsCb(id))))
    sftp.on('FSETSTAT', (id, h, attrs) => withHandle(id, true, (m) => m.remote.fsetstat(h, attrs, statusCb(id))))
    sftp.on('READDIR', (id, h) =>
      withHandle(id, false, (m) => m.remote.readdir(h, (err, list) => (err ? replyErr(id, err) : sftp.name(id, list)))),
    )
    sftp.on('SYMLINK', (id) => refuse(id, 'SFTP symlink is not supported', STATUS_CODE.OP_UNSUPPORTED))
    sftp.on('EXTENDED', (id, ext) => refuse(id, `SFTP extension ${ext} is not supported`, STATUS_CODE.OP_UNSUPPORTED))
  }

  // --- Start/stop jump server in line with grants ---
  async function startJump() {
    if (jump.state === 'on') return
    const hostKeys = utils.generateKeyPairSync('ed25519')
    const hostKey = hostKeys.public.trim().split(/\s+/).slice(0, 2).join(' ')
    const server = new SshServer({ hostKeys: [hostKeys.private], keepaliveInterval: 30_000 }, onConnection)
    server.listen(env.port, '0.0.0.0')
    await once(server, 'listening')
    jump = { state: 'on', server, hostKey }
    env.audit('ssh_jump_started', { port: env.port })
  }
  async function stopJump() {
    if (jump.state === 'off') return
    const { server } = jump
    jump = { state: 'off' }
    await new Promise<void>((done) => server.close(() => done()))
    env.audit('ssh_jump_stopped', {})
  }

  let chain: Promise<unknown> = Promise.resolve()
  const sync = () => {
    chain = chain
      .catch(() => undefined)
      .then(apply)
      .catch((error: Error) => {
        env.audit('ssh_sync_failed', { error: error.message })
        throw error
      })
    return chain
  }
  async function apply() {
    if (!speakerKey) return
    const live = sshGrants()
    for (const session of [...sessions.values()])
      if (!live.some((grant) => grant.agentId === session.agent && (!session.grant || grant.id === session.grant)))
        end(session, 'its grant ended')
    clearTimeout(timer)
    if (!live.length) return stopJump()
    await startJump()
    const next = Math.min(...live.map((grant) => (grant.expiresAt === null ? Infinity : Date.parse(grant.expiresAt))))
    if (next !== Infinity) timer = setTimeout(env.expire, Math.max(next - Date.now(), 0) + 100).unref()
  }

  // --- Admin routes (Setup forms and End) ---
  function routes(admin: Hono, fields: (c: Context) => Promise<Record<string, unknown>>, changed: () => void) {
    const guarded = (action: (form: Record<string, unknown>) => Promise<unknown>) => async (c: Context) => {
      try {
        const note = await action(await fields(c))
        changed()
        return c.redirect(
          `/admin?section=services${typeof note === 'string' ? `&sshNote=${encodeURIComponent(note)}` : ''}`,
          303,
        )
      } catch (error) {
        if (!(error instanceof SetupError)) throw error
        return c.redirect(`/admin?section=services&sshError=${encodeURIComponent(error.message.slice(0, 600))}`, 303)
      }
    }
    admin.post('/ssh/targets/add', guarded(addTarget))
    admin.post('/ssh/targets/from', guarded(setFrom))
    admin.post('/ssh/targets/check', guarded(recheck))
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
    start,
    sync,
    unknownName,
    unavailable,
    overSsh,
    describe,
    setup,
    commands,
    routes,
    sessions: () =>
      [...sessions.values()]
        .filter((session) => session.state === 'open')
        .map(({ id, agent, what, started }) => ({ id, agent, what, started })),
    async stop() {
      clearTimeout(timer)
      for (const session of [...sessions.values()]) end(session, 'speaker stopped')
      await stopJump()
      speakerKey = undefined
    },
  }
}

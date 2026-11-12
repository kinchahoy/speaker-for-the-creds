// The jump server's forced command, one process per SSH session: `node relay.ts <speaker socket> <agent id>`.
// It asks speaker (over a unix socket it keeps open for the whole session) what the agent may do, runs the system
// `ssh` to the target accordingly, and stops as soon as speaker closes the socket (grant ended, revoked, restart).
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { type Mount, relaySftp } from './sftp.ts'

export type ToSpeaker =
  | { type: 'start'; agent: string; command: string; source: string }
  | { type: 'mount'; name: string }
  | { type: 'file'; op: string; path: string }
  | { type: 'refused'; message: string }
  | { type: 'exit'; code: number }
export type FromSpeaker =
  | { type: 'refused'; message: string }
  | { type: 'run'; argv: string[] }
  | { type: 'sftp' }
  | ({ type: 'mount' } & Mount)
  | { type: 'end'; why: string }

if (import.meta.main) {
  const [socketPath, agent] = process.argv.slice(2)
  const socket = connect(socketPath)
  let children: { kill(): void }[] = []
  let finished = false
  // One line on standard error for every refusal or ended session.
  const stop = (message: string): never => {
    process.stderr.write(`speaker: ${message}. Check GET /_speaker/me\n`)
    for (const child of children) child.kill()
    process.exit(1)
  }
  socket.on('error', (error) => stop(`cannot reach speaker (${error.message})`))
  socket.on('close', () => finished || stop('the session ended: speaker closed it'))
  let waiter: ((message: FromSpeaker) => void) | undefined
  createInterface({ input: socket }).on('line', (line) => {
    const message = JSON.parse(line) as FromSpeaker
    if (message.type === 'end') return stop(`the session ended: ${message.why}`)
    waiter?.(message)
    waiter = undefined
  })
  const say = (message: ToSpeaker) => void socket.write(`${JSON.stringify(message)}\n`)
  const call = (message: ToSpeaker) =>
    new Promise<FromSpeaker>((done) => {
      waiter = done
      say(message)
    })
  const finish = (code: number) => {
    finished = true
    say({ type: 'exit', code })
    socket.end(() => process.exit(code))
  }

  const first = await call({
    type: 'start',
    agent,
    command: process.env.SSH_ORIGINAL_COMMAND ?? '',
    source: (process.env.SSH_CONNECTION ?? '').split(' ')[0],
  })
  if (first.type === 'refused') stop(first.message)
  if (first.type === 'run') {
    const child = spawn(first.argv[0], first.argv.slice(1), { stdio: 'inherit' })
    children = [child]
    child.on('close', (code) => finish(code ?? 255))
  } else if (first.type === 'sftp') {
    await relaySftp(process.stdin, process.stdout, {
      async mount(name) {
        const reply = await call({ type: 'mount', name })
        if (reply.type === 'refused') return reply.message
        return reply.type === 'mount' ? reply : 'unexpected reply from speaker'
      },
      spawn(mount) {
        const child = spawn(mount.argv[0], mount.argv.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] })
        children = [child]
        return child
      },
      log: (op, path) => say({ type: 'file', op, path }),
      refused(message) {
        say({ type: 'refused', message })
        process.stderr.write(`speaker: refused: ${message}. Check GET /_speaker/me\n`)
      },
    }).then(
      () => finish(0),
      (error: Error) => stop(error.message),
    )
  }
}

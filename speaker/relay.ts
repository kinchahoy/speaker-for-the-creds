// The jump server's forced command, one process per SSH session: `node relay.ts <speaker socket> <agent id>`.
// It asks speaker (over a unix socket it keeps open for the whole session) what the agent may do, runs the system
// `ssh` to the target accordingly, and stops as soon as speaker closes the socket (grant ended, revoked, restart).
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { relaySftp } from './sftp.ts'

export const toSpeaker = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), agent: z.string(), command: z.string(), source: z.string() }),
  z.object({ type: z.literal('mount'), name: z.string() }),
  z.object({ type: z.literal('file'), op: z.string(), path: z.string() }),
  z.object({ type: z.literal('refused'), message: z.string() }),
  z.object({ type: z.literal('exit'), code: z.number() }),
])
export type ToSpeaker = z.infer<typeof toSpeaker>
export const fromSpeaker = z.discriminatedUnion('type', [
  z.object({ type: z.literal('refused'), message: z.string() }),
  z.object({ type: z.literal('run'), argv: z.array(z.string()) }),
  z.object({ type: z.literal('sftp') }),
  z.object({
    type: z.literal('mount'),
    name: z.string(),
    readOnly: z.boolean(),
    absolute: z.boolean(),
    argv: z.array(z.string()),
  }),
  z.object({ type: z.literal('end'), why: z.string() }),
])
export type FromSpeaker = z.infer<typeof fromSpeaker>

if (import.meta.main) {
  const [socketPath, agent] = z.tuple([z.string(), z.string()]).parse(process.argv.slice(2))
  const socket = connect(socketPath)
  let child: { kill(): void } | undefined
  // `running` until the session finishes on its own; speaker closing the socket before that ends it.
  let state: 'running' | 'finished' = 'running'
  // One line on standard error for every refusal or ended session.
  const stop = (message: string): never => {
    process.stderr.write(`speaker: ${message}. Check GET /_speaker/catalog\n`)
    child?.kill()
    process.exit(1)
  }
  socket.on('error', (error) => stop(`cannot reach speaker (${error.message})`))
  socket.on('close', () => state === 'finished' || stop('the session ended: speaker closed it'))
  // Speaker answers each call with one line, in order.
  const replies: ((message: FromSpeaker) => void)[] = []
  createInterface({ input: socket }).on('line', (line) => {
    const message = fromSpeaker.parse(JSON.parse(line))
    if (message.type === 'end') stop(`the session ended: ${message.why}`)
    replies.shift()?.(message)
  })
  const say = (message: ToSpeaker) => void socket.write(`${JSON.stringify(message)}\n`)
  const call = (message: ToSpeaker) => new Promise<FromSpeaker>((done) => replies.push(done) && say(message))
  const finish = (code: number) => {
    state = 'finished'
    say({ type: 'exit', code })
    socket.end(() => process.exit(code))
  }
  const run = (argv: string[], stdio: 'inherit' | ['pipe', 'pipe', 'inherit']) => {
    const started = spawn(argv[0], argv.slice(1), { stdio })
    child = started
    return started
  }

  const env = z
    .object({ SSH_CONNECTION: z.string().default(''), SSH_ORIGINAL_COMMAND: z.string().default('') })
    .parse(process.env)
  const source = env.SSH_CONNECTION.split(' ')[0]
  const first = await call({ type: 'start', agent, command: env.SSH_ORIGINAL_COMMAND, source })
  if (first.type === 'refused') stop(first.message)
  if (first.type === 'run') run(first.argv, 'inherit').on('close', (code) => finish(code ?? 255))
  if (first.type === 'sftp')
    await relaySftp(process.stdin, process.stdout, {
      async mount(name) {
        const reply = await call({ type: 'mount', name })
        return reply.type === 'refused'
          ? reply.message
          : reply.type === 'mount'
            ? reply
            : 'unexpected reply from speaker'
      },
      spawn(mount) {
        const { stdin, stdout } = run(mount.argv, ['pipe', 'pipe', 'inherit'])
        if (!stdin || !stdout) throw new Error('the target sftp-server has no pipes')
        return { stdin, stdout }
      },
      log: (op, path) => say({ type: 'file', op, path }),
      refused(message) {
        say({ type: 'refused', message })
        process.stderr.write(`speaker: refused: ${message}. Check GET /_speaker/catalog\n`)
      },
    }).then(
      () => finish(0),
      (error: Error) => stop(error.message),
    )
}

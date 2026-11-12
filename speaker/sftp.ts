// A filtering SFTP v3 relay: reads the client's requests, keeps them inside one mount, forwards what is allowed to
// the target's own sftp-server and passes the replies back. Only the packet types an OpenSSH client, scp or sshfs
// uses are understood; everything else is refused. (ssh2's SFTP implementation is bound to an SSH channel and
// cannot parse a plain stream, so this is the smallest parser that covers the needed types.)
import type { Readable, Writable } from 'node:stream'

const fxp = {
  init: 1,
  version: 2,
  open: 3,
  close: 4,
  read: 5,
  write: 6,
  lstat: 7,
  fstat: 8,
  setstat: 9,
  fsetstat: 10,
  opendir: 11,
  readdir: 12,
  remove: 13,
  mkdir: 14,
  rmdir: 15,
  realpath: 16,
  stat: 17,
  rename: 18,
  readlink: 19,
  status: 101,
  name: 104,
}
const code = { denied: 3, failure: 4, unsupported: 8 }
const maxPacket = 1_048_576

const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const str = (s: string) => {
  const b = Buffer.from(s)
  return Buffer.concat([u32(b.length), b])
}
// A packet body (type byte onward); `wire` adds the length prefix.
const body = (kind: number, ...parts: Buffer[]) => Buffer.concat([Buffer.from([kind]), ...parts])
const wire = (packet: Buffer) => Buffer.concat([u32(packet.length), packet])
const statusOf = (id: number, status: number, message: string) =>
  body(fxp.status, u32(id), u32(status), str(message), str(''))
const nameOf = (id: number, path: string) => body(fxp.name, u32(id), u32(1), str(path), str(path), u32(0))

class Reader {
  pos = 0
  buf: Buffer
  constructor(buf: Buffer) {
    this.buf = buf
  }
  u32() {
    const n = this.buf.readUInt32BE(this.pos)
    this.pos += 4
    return n
  }
  str() {
    const length = this.u32()
    if (this.pos + length > this.buf.length) throw new Error('Truncated SFTP packet')
    const s = this.buf.toString('utf8', this.pos, this.pos + length)
    this.pos += length
    return s
  }
  rest() {
    return this.buf.subarray(this.pos)
  }
}

// Calls `each` with every complete packet body in the stream.
const framer = (each: (packet: Buffer) => void) => {
  let held = Buffer.alloc(0)
  return (chunk: Buffer) => {
    held = Buffer.concat([held, chunk])
    while (held.length >= 4) {
      const length = held.readUInt32BE(0)
      if (length === 0 || length > maxPacket) throw new Error(`Bad SFTP packet length ${length}`)
      if (held.length < 4 + length) return
      each(held.subarray(4, 4 + length))
      held = held.subarray(4 + length)
    }
  }
}

// What an operation does to its paths. `follow`: it follows a final symlink, so the path itself must resolve inside
// the mount; otherwise only its parent directory is checked.
const pathOps: Record<number, { name: string; paths: 1 | 2; write: boolean; follow: boolean }> = {
  [fxp.open]: { name: 'open', paths: 1, write: false, follow: true },
  [fxp.stat]: { name: 'stat', paths: 1, write: false, follow: true },
  [fxp.lstat]: { name: 'lstat', paths: 1, write: false, follow: false },
  [fxp.opendir]: { name: 'opendir', paths: 1, write: false, follow: true },
  [fxp.setstat]: { name: 'setstat', paths: 1, write: true, follow: true },
  [fxp.readlink]: { name: 'readlink', paths: 1, write: false, follow: false },
  [fxp.remove]: { name: 'remove', paths: 1, write: true, follow: false },
  [fxp.mkdir]: { name: 'mkdir', paths: 1, write: true, follow: false },
  [fxp.rmdir]: { name: 'rmdir', paths: 1, write: true, follow: false },
  [fxp.rename]: { name: 'rename', paths: 2, write: true, follow: false },
  [fxp.realpath]: { name: 'realpath', paths: 1, write: false, follow: true },
}
// Operations on an open handle: the path was checked when it was opened. Symlinks and extensions are not here.
const handleOps: Record<number, { write: boolean }> = {
  [fxp.close]: { write: false },
  [fxp.read]: { write: false },
  [fxp.fstat]: { write: false },
  [fxp.readdir]: { write: false },
  [fxp.write]: { write: true },
  [fxp.fsetstat]: { write: true },
}

// One mount: a share (paths stay inside it; the target's sftp-server starts in it) or a whole target account
// (`absolute`: paths are absolute on the target and not contained).
export type Mount = { name: string; readOnly: boolean; absolute: boolean; argv: string[] }
export type Backend = { stdin: Writable; stdout: Readable }
export type Hooks = {
  // Resolves the first path component to a mount, or a refusal message.
  mount(name: string): Promise<Mount | string>
  // Starts the target's sftp-server.
  spawn(mount: Mount): Backend
  // Records a file operation.
  log(op: string, path: string): void
  // Records and reports a refusal.
  refused(message: string): void
}

// Lexical path parts: `/a/./b/../c` is [a, c]; `..` at the top stays at the top.
const parts = (path: string) => {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return out
}

type Mounted = { mount: Mount; backend: Backend; root: string; closed: Promise<void> }

// Relays one SFTP session between `input` and `output` (the agent) and the target (started at the first path).
export function relaySftp(input: Readable, output: Writable, hooks: Hooks): Promise<void> {
  let mounted: Mounted | undefined
  let nextId = 1
  const waiting = new Map<number, (reply: Buffer) => void>()
  const send = (packet: Buffer) => output.write(wire(packet))
  const refuse = (id: number, message: string, status: number = code.denied) => {
    hooks.refused(message)
    send(statusOf(id, status, message))
  }
  // Sends a request to the target under a fresh id; the reply comes back under it.
  const ask = (backend: Backend, kind: number, ...parts: Buffer[]) =>
    new Promise<Buffer>((done) => {
      const id = nextId++
      waiting.set(id, done)
      backend.stdin.write(wire(body(kind, u32(id), ...parts)))
    })
  // The target's answer with the id the client used.
  const answer = (id: number, reply: Buffer) => {
    reply.writeUInt32BE(id, 1)
    send(reply)
  }
  // What the target says a path resolves to, or the status reply it answered instead.
  async function realpath(backend: Backend, path: string) {
    const reply = await ask(backend, fxp.realpath, str(path))
    if (reply[0] !== fxp.name) return reply
    const r = new Reader(reply.subarray(5))
    r.u32()
    return r.str()
  }

  async function start(mount: Mount) {
    const backend = hooks.spawn(mount)
    let versioned: () => void = () => undefined
    const ready = new Promise<void>((done) => {
      versioned = done
    })
    const onData = framer((p) => {
      if (p[0] === fxp.version) return versioned()
      const done = waiting.get(p.readUInt32BE(1))
      waiting.delete(p.readUInt32BE(1))
      done?.(p)
    })
    backend.stdout.on('data', (chunk: Buffer) => onData(chunk))
    const closed = new Promise<void>((done) => {
      backend.stdout.on('close', () => {
        for (const [id, reply] of waiting) reply(statusOf(id, code.failure, 'The connection to the target ended'))
        waiting.clear()
        output.end()
        done()
      })
    })
    backend.stdin.write(wire(body(fxp.init, u32(3))))
    await ready
    let root = '/'
    if (!mount.absolute) {
      const resolved = await realpath(backend, '.')
      if (typeof resolved !== 'string') throw new Error('The target refused to open the share')
      root = resolved
    }
    mounted = { mount, backend, root, closed }
  }

  // A target path as the client sees it in the share's namespace, or undefined when it lies outside.
  const virtual = ({ mount, root }: Mounted, path: string) => {
    if (mount.absolute) return `/${mount.name}${path === '/' ? '' : path}`
    const prefix = root.endsWith('/') ? root : `${root}/`
    return path === root
      ? `/${mount.name}`
      : path.startsWith(prefix)
        ? `/${mount.name}/${path.slice(prefix.length)}`
        : undefined
  }

  async function handle(p: Buffer) {
    const kind = p[0]
    if (kind === fxp.init) return void send(body(fxp.version, u32(3)))
    const id = p.readUInt32BE(1)
    const op = pathOps[kind]
    if (!op) {
      const handleOp = handleOps[kind]
      if (!handleOp) return refuse(id, `SFTP operation ${kind} is not supported`, code.unsupported)
      if (!mounted) return refuse(id, 'Name a share first: paths start with <share>/', code.failure)
      if (handleOp.write && mounted.mount.readOnly) return refuse(id, 'This grant is read-only')
      const reply = await ask(mounted.backend, kind, p.subarray(5))
      return answer(id, reply)
    }
    const r = new Reader(p.subarray(5))
    const comps = [r.str(), ...(op.paths === 2 ? [r.str()] : [])].map(parts)
    const tail = r.rest()
    // OPEN carries its flags after the path: anything beyond reading is a write.
    const writes = op.write || (kind === fxp.open && (tail.readUInt32BE(0) & ~1) !== 0)
    // The top of the namespace answers REALPATH and nothing else: shares are never listed.
    if (comps.some((c) => !c.length)) {
      if (kind === fxp.realpath) return void send(nameOf(id, '/'))
      return refuse(id, 'Name a share first: paths start with <share>/')
    }
    if (!mounted) {
      const chosen = await hooks.mount(comps[0][0])
      if (typeof chosen === 'string') return refuse(id, chosen)
      await start(chosen)
    }
    const current = mounted as Mounted
    const { mount, backend, root } = current
    if (comps.some((c) => c[0] !== mount.name)) return refuse(id, `One share per session: this one is ${mount.name}`)
    if (writes && mount.readOnly) return refuse(id, 'This grant is read-only')
    const rests = comps.map((c) => c.slice(1))
    const onTarget = (rest: string[]) => (mount.absolute ? `/${rest.join('/')}` : rest.join('/') || '.')
    // A share cannot be removed or renamed from inside itself.
    if (!mount.absolute && op.write && !op.follow && rests.some((rest) => !rest.length))
      return refuse(id, 'The share itself cannot be changed')
    if (!mount.absolute)
      for (const rest of rests) {
        // The target resolves the path, symlinks included; the result must stay inside the share.
        const resolved = await realpath(backend, rest.length ? onTarget(op.follow ? rest : rest.slice(0, -1)) : '.')
        if (typeof resolved !== 'string') return answer(id, resolved)
        if (!(resolved === root || resolved.startsWith(root.endsWith('/') ? root : `${root}/`)))
          return refuse(id, 'Outside the share')
      }
    hooks.log(kind === fxp.open && writes ? 'open (write)' : op.name, comps.map((c) => `/${c.join('/')}`).join(' -> '))
    const reply = await ask(backend, kind, ...rests.map((rest) => str(onTarget(rest))), tail)
    if (reply[0] !== fxp.name) return answer(id, reply)
    // REALPATH and READLINK name a path on the target; the client sees it in the share's namespace.
    const named = new Reader(reply.subarray(5))
    named.u32()
    const text = named.str()
    const shown = virtual(current, text)
    if (kind === fxp.realpath && shown === undefined) return refuse(id, 'Outside the share')
    send(nameOf(id, shown ?? text))
  }

  return new Promise<void>((done, fail) => {
    // Requests are dispatched in order; the target answers them as it likes.
    let queue = Promise.resolve()
    const onData = framer((p) => {
      queue = queue.then(() => handle(p)).catch(fail)
    })
    input.on('data', (chunk: Buffer) => {
      try {
        onData(chunk)
      } catch (error) {
        fail(error)
      }
    })
    input.on('end', () => {
      queue
        .then(async () => {
          mounted?.backend.stdin.end()
          await mounted?.closed
          done()
        })
        .catch(fail)
    })
  })
}

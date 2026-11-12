// `mise run init speaker`: asks where speaker keeps its data, which ports and address it uses and the owner password,
// creates the encrypted store with speaker's own code, and writes speaker/.env. Every question has a flag (see below).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, open, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type parseArgs, styleText } from 'node:util'
import * as p from '@clack/prompts'
import { createCore, readConfig } from './core.ts'

export const speakerFlags = {
  yes: { type: 'boolean' },
  force: { type: 'boolean' },
  'data-dir': { type: 'string' },
  port: { type: 'string' },
  'proxy-port': { type: 'string' },
  'ssh-port': { type: 'string' },
  address: { type: 'string' },
  'public-url': { type: 'string' },
  'trusted-proxy': { type: 'string' },
  'password-stdin': { type: 'boolean' },
  start: { type: 'boolean' },
  'no-start': { type: 'boolean' },
  'env-path': { type: 'string' },
} as const
export type SpeakerFlags = ReturnType<typeof parseArgs<{ options: typeof speakerFlags }>>['values']

const here = import.meta.dirname
// Successes get their own check mark, so they cannot be mistaken for a question's diamond.
const ok = (message: string) => p.log.message(message, { symbol: styleText('green', '✓') })
export const fail = (what: string, fix: string): never => {
  throw new Error(`${what}. Fix: ${fix}`)
}
// Ends the run when the owner presses Ctrl-C at a prompt.
const answered = <T>(value: T | symbol): Exclude<T, symbol> => {
  if (p.isCancel(value)) {
    p.cancel('Cancelled. Nothing more was changed.')
    process.exit(1)
  }
  return value as Exclude<T, symbol>
}
// The flag if given, else the default under --yes, else the prompt.
const ask = async <T, F extends T | undefined>(
  given: T | undefined,
  yes: boolean,
  fallback: F,
  prompt: () => Promise<NoInfer<T> | symbol>,
): Promise<T | F> => given ?? (yes ? fallback : (answered(await prompt()) as T))

const isFree = (port: number) =>
  new Promise<boolean>((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.listen(port, '0.0.0.0', () => probe.close(() => done(true)))
  })

const lanAddress = () =>
  Object.values(networkInterfaces())
    .flat()
    .find(
      (entry) =>
        entry?.family === 'IPv4' &&
        !entry.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address),
    )?.address

async function pickPort(
  given: string | undefined,
  yes: boolean,
  label: string,
  purpose: string,
  flag: string,
  fallback: number,
  taken: number[],
) {
  for (let value = given; ; value = undefined) {
    const raw = await ask(value, yes, String(fallback), () =>
      p.text({
        message: `${label} port: ${purpose} (Enter keeps ${fallback})`,
        placeholder: String(fallback),
        defaultValue: String(fallback),
      }),
    )
    const port = Number(raw)
    const problem =
      !Number.isInteger(port) || port < 1 || port > 65535
        ? 'is not a port number'
        : taken.includes(port) || !(await isFree(port))
          ? 'is already in use'
          : undefined
    if (!problem) return port
    if (value !== undefined || yes) fail(`${label} port ${raw} ${problem}`, `choose another with --${flag}`)
    p.log.warn(`${raw} ${problem}. Choose another.`)
  }
}

const readStdin = async () => {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text.replace(/\r?\n$/, '')
}

async function ownerPassword(flags: SpeakerFlags, yes: boolean) {
  if (flags['password-stdin']) return readStdin()
  if (yes) fail('--yes needs the owner password', 'pipe it in and pass --password-stdin')
  const first = answered(
    await p.password({
      message: 'Owner password (at least 8 characters)',
      validate: (v) => ((v ?? '').length < 8 ? 'Use at least 8 characters.' : undefined),
    }),
  )
  answered(
    await p.password({
      message: 'Repeat the password',
      validate: (v) => (v === first ? undefined : 'The two passwords differ.'),
    }),
  )
  return first
}

// Starts speaker detached, with its output in the data directory, and waits until it answers.
async function startSpeaker(envFile: string, dataDir: string, port: number) {
  const log = await open(join(dataDir, 'speaker.log'), 'a', 0o600)
  const child = spawn(process.execPath, [`--env-file=${envFile}`, 'server.ts'], {
    cwd: here,
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
  })
  child.unref()
  await log.close()
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  for (let tries = 0; tries < 60 && !exited; tries += 1) {
    if (
      await fetch(`http://127.0.0.1:${port}/_speaker/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return child.pid
    await sleep(250)
  }
  return fail('speaker did not start', `read ${join(dataDir, 'speaker.log')}`)
}

// Speaker starts locked; one sign-in with the owner password unlocks it. The password stays in memory.
async function unlock(port: number, publicUrl: string, password: string) {
  const response = await fetch(`http://127.0.0.1:${port}/admin/signin`, {
    method: 'POST',
    // /admin refuses form posts that do not come from its own origin.
    headers: { origin: new URL(publicUrl).origin },
    body: new URLSearchParams({ password }),
    redirect: 'manual',
  })
  if (response.status !== 303)
    fail(`speaker did not accept the owner password (HTTP ${response.status})`, 'sign in at /admin yourself')
}

export async function initSpeaker(flags: SpeakerFlags) {
  const yes = flags.yes ?? false
  p.intro('speaker setup')
  const envFile = resolve(flags['env-path'] ?? join(here, '.env'))
  if (existsSync(envFile) && !flags.force) fail(`${envFile} already exists`, 'delete it, or pass --force to replace it')

  const defaultDir = join(homedir(), '.local', 'share', 'speaker')
  const dataDir = resolve(
    (
      await ask(flags['data-dir'], yes, defaultDir, () =>
        p.text({
          message: `Where should speaker keep its data (keys, settings)? (Enter keeps ${defaultDir})`,
          placeholder: defaultDir,
          defaultValue: defaultDir,
        }),
      )
    ).replace(/^~(?=\/|$)/, homedir()),
  )
  if (existsSync(join(dataDir, 'store.json')))
    fail(
      `${dataDir} already holds an owner password`,
      'choose another data directory, or delete store.json there to start over (this loses every stored key)',
    )

  const port = await pickPort(flags.port, yes, 'Web', 'the admin page and agents use it', 'port', 3000, [])
  const proxyPort = await pickPort(
    flags['proxy-port'],
    yes,
    'Secrets proxy',
    'agents send HTTPS here to use secrets',
    'proxy-port',
    3128,
    [port],
  )
  const sshPort = await pickPort(
    flags['ssh-port'],
    yes,
    'SSH jump server',
    'SSH and folders go through it',
    'ssh-port',
    2222,
    [port, proxyPort],
  )

  const detected = lanAddress()
  const address = await ask(flags.address, yes, detected, () =>
    p.text({
      message: `Address agents and VMs use to reach this machine${detected ? ` (Enter keeps ${detected})` : ''}`,
      placeholder: detected,
      defaultValue: detected,
      validate: (v) => (v || detected ? undefined : 'Enter an address.'),
    }),
  )
  if (!address) fail('no LAN address found', 'pass --address <ip or hostname>')

  const proxied =
    flags['trusted-proxy'] !== undefined ||
    flags['public-url'] !== undefined ||
    (!yes && answered(await p.confirm({ message: 'Is speaker behind a reverse proxy?', initialValue: false })))
  let publicUrl = `http://${address}:${port}`
  let trustedProxy: string | undefined
  if (proxied) {
    publicUrl =
      (
        await ask(flags['public-url'], yes, undefined, () =>
          p.text({ message: 'URL you open in the browser', placeholder: 'https://speaker.example.com' }),
        )
      )?.replace(/\/$/, '') ?? fail('--yes with a reverse proxy needs the browser URL', 'pass --public-url')
    trustedProxy = await ask(flags['trusted-proxy'], yes, undefined, () =>
      p.text({ message: "The reverse proxy's IP address (TRUSTED_PROXY)", placeholder: '172.18.0.2' }),
    )
    if (!trustedProxy) fail('a reverse proxy needs its IP address', 'pass --trusted-proxy <ip>')
  }

  const password = await ownerPassword(flags, yes)
  const env = {
    DATA_DIR: dataDir,
    PORT: String(port),
    PUBLIC_URL: publicUrl,
    PROXY_PORT: String(proxyPort),
    SSH_PORT: String(sshPort),
    ...(trustedProxy ? { TRUSTED_PROXY: trustedProxy } : {}),
  }
  const config = (() => {
    try {
      return readConfig(env)
    } catch (error) {
      return fail(
        `these settings are not valid:\n${(error as Error).message}`,
        'correct the flag or answer, then run init again',
      )
    }
  })()

  // The owner's store comes from speaker's own code: the same vault and password wrapping the first /admin visit makes.
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const core = await createCore(config)
  try {
    await core.createOwnerStore(password)
  } finally {
    await core.jump.stop()
  }
  await writeFile(
    envFile,
    `# Written by \`mise run init speaker\`.\n${Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
    { mode: 0o600 },
  )
  await chmod(envFile, 0o600)
  ok(`Wrote ${envFile} and the encrypted store in ${dataDir}.`)

  const command =
    envFile === join(here, '.env') ? 'mise run speaker' : `cd ${here} && node --env-file=${envFile} server.ts`
  const start = flags.start
    ? true
    : flags['no-start']
      ? false
      : yes || answered(await p.confirm({ message: 'Start speaker now (in the background)?', initialValue: true }))
  if (start) {
    const pid = await startSpeaker(envFile, dataDir, port)
    ok(`Speaker is running (pid ${pid}). Log: ${join(dataDir, 'speaker.log')}. Stop it with: kill ${pid}`)
    await unlock(port, publicUrl, password)
    ok(`Speaker is unlocked. After every restart, sign in at ${publicUrl}/admin with the owner password.`)
  } else {
    p.log.info(`Start speaker with: ${command}`)
    p.log.info(`Then sign in at ${publicUrl}/admin with the owner password. Speaker stays locked until you do.`)
  }
  if (trustedProxy)
    p.log.warn(
      `Behind a reverse proxy, open ports ${proxyPort} (secrets proxy) and ${sshPort} (SSH) on this machine directly: the proxy cannot carry them. Also raise its timeout above 120 s, since speaker holds requests for up to 120 s.`,
    )
  p.outro('Speaker is set up.')
  return { url: publicUrl, started: start, password }
}

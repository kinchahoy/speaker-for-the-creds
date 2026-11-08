// Speaker as an SSH user certificate authority. Signing shells out to OpenSSH's own ssh-keygen,
// the reference implementation of the certificate format and its options.
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const run = promisify(execFile)

const nameSchema = z.string().regex(/^[a-z_][a-z0-9_.-]{0,31}$/, 'Use a plain login name')
export const sshHostsSchema = z.record(
  z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  z.object({
    hostname: z.string().regex(/^[a-zA-Z0-9.-]{1,253}$/, 'Use a host name or IPv4 address'),
    port: z.number().int().min(1).max(65535).default(22),
    users: z.array(nameSchema).min(1),
  }),
)
export type SshHosts = z.infer<typeof sshHostsSchema>

export const sshRequestSchema = z.object({
  host: z.string(),
  user: nameSchema,
  publicKey: z
    .string()
    .trim()
    .regex(
      /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( [^\r\n]*)?$/,
      'Send one ed25519 or ECDSA public key',
    ),
  sourceAddress: z
    .string()
    .regex(/^[0-9a-fA-F.:/]+(,[0-9a-fA-F.:/]+)*$/, 'Use comma-separated addresses or CIDR blocks')
    .optional(),
  agentForwarding: z.boolean().default(false),
  portForwarding: z.boolean().default(false),
})
export type SshRequest = z.infer<typeof sshRequestSchema>

/** The certificate principal names user and host alias, so a certificate for one host does not open another. */
export const principalOf = (user: string, host: string) => `${user}@${host}`

async function withKeyFile<T>(publicKey: string, use: (path: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'speaker-ssh-'))
  try {
    const path = join(dir, 'key.pub')
    await writeFile(path, `${publicKey}\n`, { mode: 0o600 })
    return await use(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Derives the CA public key; fails when the key is missing, unreadable, too open, or ssh-keygen is absent. */
export async function caPublicKey(caKeyPath: string) {
  const derived = await run('ssh-keygen', ['-y', '-f', caKeyPath]).catch((error: Error & { stderr?: string }) => {
    throw new Error(
      `SSH_CA_KEY ${caKeyPath} is unusable (${error.stderr?.trim() || error.message}). Create it with \`mise run ssh-ca\`, owner-only (chmod 600).`,
    )
  })
  return derived.stdout.trim()
}

/** Parses an agent's public key with ssh-keygen; returns its SHA256 fingerprint, or undefined when it is not a key. */
export async function fingerprint(publicKey: string) {
  return withKeyFile(publicKey, (path) =>
    run('ssh-keygen', ['-l', '-f', path]).then(
      ({ stdout }) => stdout.split(' ')[1],
      () => undefined,
    ),
  )
}

export type CertificateOrder = SshRequest & { principal: string; keyId: string; seconds: number }

/** Signs a user certificate valid from one minute ago (clock skew) for `seconds`, with only the listed permissions. */
export async function signCertificate(caKeyPath: string, order: CertificateOrder) {
  const options = ['clear', 'permit-pty']
  if (order.agentForwarding) options.push('permit-agent-forwarding')
  if (order.portForwarding) options.push('permit-port-forwarding')
  if (order.sourceAddress) options.push(`source-address=${order.sourceAddress}`)
  return withKeyFile(order.publicKey, async (path) => {
    await run('ssh-keygen', [
      '-q',
      '-s',
      caKeyPath,
      '-I',
      order.keyId,
      '-n',
      order.principal,
      '-V',
      `-1m:+${order.seconds}s`,
      '-z',
      String(Date.now()),
      ...options.flatMap((option) => ['-O', option]),
      path,
    ])
    return (await readFile(path.replace(/\.pub$/, '-cert.pub'), 'utf8')).trim()
  })
}

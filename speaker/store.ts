// The encrypted store: one file holding a random data key, wrapped by a key scrypt derives from the owner's password,
// and every secret sealed with that data key (AES-256-GCM). A successful unwrap is the password check, so no password
// hash is stored. Clear values exist only in memory after unlock.
import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import writeFile from 'write-file-atomic'

const run = promisify(execFile)

export type OwnerSecret = { value: string; hosts: string[]; env: string }
export type Vault = {
  // Upstream key of each service, by service id.
  services: Record<string, string>
  // Secrets agents may use without seeing them, by name: the hosts they may be sent to and the variable the agent sees.
  secrets: Record<string, OwnerSecret>
  // Speaker's SSH key for its targets.
  ssh: { private: string; public: string }
  // Certificate authority of the secrets proxy (PEM), made at first need.
  ca?: { cert: string; key: string }
}
export type Store = { vault: Vault; save(): Promise<void>; setPassword(password: string): Promise<void> }
export class WrongPassword extends Error {
  constructor() {
    super('Wrong password')
  }
}

type Sealed = { iv: string; tag: string; data: string }
type Wrap = { salt: string; key: Sealed }

const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((done, fail) =>
    scrypt(password.normalize('NFKC'), salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 2 ** 20 }, (error, key) =>
      error ? fail(error) : done(key),
    ),
  )
const seal = (key: Buffer, plain: Buffer | string): Sealed => {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}
const open = (key: Buffer, { iv, tag, data }: Sealed) => {
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  cipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()])
}
const wrapKey = async (password: string, dataKey: Buffer): Promise<Wrap> => {
  const salt = randomBytes(16)
  return { salt: salt.toString('base64'), key: seal(await derive(password, salt), dataKey) }
}

function store(path: string, dataKey: Buffer, vault: Vault, wrap: Wrap): Store {
  const save = () =>
    writeFile(path, JSON.stringify({ ...wrap, vault: seal(dataKey, JSON.stringify(vault)) }, null, 2), { mode: 0o600 })
  return {
    vault,
    save,
    // Re-wraps the same data key under the new password; the sealed secrets are unchanged.
    async setPassword(password) {
      wrap = await wrapKey(password, dataKey)
      await save()
    },
  }
}

// Speaker's own SSH key, made with OpenSSH's ssh-keygen in a private temporary directory.
export async function generateSshKey(): Promise<Vault['ssh']> {
  const dir = await mkdtemp(join(tmpdir(), 'speaker-key-'))
  try {
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'speaker', '-f', join(dir, 'key')]).catch(
      (error: Error) => {
        throw new Error(`ssh-keygen is required to create speaker's SSH key: ${error.message}`)
      },
    )
    return {
      private: await readFile(join(dir, 'key'), 'utf8'),
      public: (await readFile(join(dir, 'key.pub'), 'utf8')).trim(),
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function createStore(path: string, password: string, vault: Vault): Promise<Store> {
  const dataKey = randomBytes(32)
  const created = store(path, dataKey, vault, await wrapKey(password, dataKey))
  await created.save()
  return created
}

// Throws WrongPassword unless the password unwraps the data key.
export async function openStore(path: string, password: string): Promise<Store> {
  const file = JSON.parse(await readFile(path, 'utf8')) as Wrap & { vault: Sealed }
  let dataKey: Buffer
  try {
    dataKey = open(await derive(password, Buffer.from(file.salt, 'base64')), file.key)
  } catch {
    throw new WrongPassword()
  }
  return store(path, dataKey, JSON.parse(open(dataKey, file.vault).toString('utf8')) as Vault, file)
}

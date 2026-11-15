import type { Server } from 'node:http'
import { createServer } from 'node:net'
import { after } from 'node:test'

export const ownerPassword = 'owner-password-for-tests'

// The `name=value` pair of the session cookie a sign-in or first-run response set.
export const sessionCookie = (response: Response) => {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('speaker_session='))
  if (!cookie) throw new Error('No session cookie in the response')
  return cookie.split(';')[0]
}

// Sets the owner password through the first-run form and returns the session cookie for later admin calls.
export async function setOwnerPassword(
  call: (path: string, init?: RequestInit) => Response | Promise<Response>,
  origin = 'http://localhost',
): Promise<string> {
  const response = await call('/admin/setup', {
    method: 'POST',
    headers: { origin },
    body: new URLSearchParams({ password: ownerPassword, confirm: ownerPassword }),
    redirect: 'manual',
  })
  if (response.status !== 303) throw new Error(`Setting the owner password answered ${response.status}`)
  return sessionCookie(response)
}

// A free port from 20000–29999, below the OS's range for port-0 binds: test files run in parallel, and a server one of
// them starts on port 0 must not take a port another has picked but speaker opens only later (the jump server listens
// only while a grant is active).
export async function freePort() {
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 10000)
    const probe = createServer()
    const free = await new Promise<boolean>((ok) => probe.once('error', () => ok(false)).listen(port, () => ok(true)))
    if (free) return new Promise<number>((done) => probe.close(() => done(port)))
  }
}

// Free ports for the PROXY_PORT and SSH_PORT every speaker requires.
export const freePorts = async () => ({ PROXY_PORT: String(await freePort()), SSH_PORT: String(await freePort()) })

// Speaker now always starts its proxy and ssh-agent: stop them when the test file ends so its process can exit.
const started: { proxy: Server; stop(): Promise<void> }[] = []
after(() =>
  Promise.all(
    started.map(async (app) => {
      app.proxy.close()
      await app.stop()
    }),
  ),
)
export function quiet<T extends { proxy: Server; stop(): Promise<void> }>(app: T) {
  app.proxy.unref()
  started.push(app)
  return app
}

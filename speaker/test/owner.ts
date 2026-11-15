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

// Free ports for the PROXY_PORT and SSH_PORT every speaker now requires.
export async function freePorts() {
  const probes = await Promise.all(
    [0, 0].map(
      () =>
        new Promise<ReturnType<typeof createServer>>((ok) => {
          const probe = createServer().listen(0, () => ok(probe))
        }),
    ),
  )
  const [PROXY_PORT, SSH_PORT] = probes.map((probe) => String((probe.address() as { port: number }).port))
  await Promise.all(probes.map((probe) => new Promise((done) => probe.close(done))))
  return { PROXY_PORT, SSH_PORT }
}

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

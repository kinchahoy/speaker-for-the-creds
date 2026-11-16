import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createApp, readConfig } from '../server.ts'
import { createStore, generateSshKey, openStore, type Vault } from '../store.ts'
import { freePorts, ownerPassword, sessionCookie, quiet, setOwnerPassword } from './owner.ts'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const locked = {
  error: 'locked',
  message: 'Speaker is locked',
  next: 'Wait until the owner has signed in, then repeat the call',
  tell_user: 'Speaker restarted: sign in at http://localhost/admin to unlock',
}

async function dataDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'speaker-keys-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
// Starts speaker on a data directory; calling it again on the same directory is a restart.
async function start(dir: string, env: Record<string, string> = {}) {
  const app = quiet(
    await createApp(readConfig({ DATA_DIR: dir, PUBLIC_URL: 'http://localhost', ...(await freePorts()), ...env })),
  )
  const call = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init }))
  const form = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    call(path, { method: 'POST', headers: { origin: 'http://localhost', ...headers }, body: new URLSearchParams(body) })
  const signIn = (password = ownerPassword) => form('/admin/signin', { password })
  const enroll = (token: string, body: object = {}) =>
    call('/_speaker/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: token, agent: 'Test LLM · Test app', tokenHash: sha(token), ...body }),
    })
  return { call, form, signIn, enroll }
}
const filesOf = async (dir: string) =>
  Promise.all(
    (await readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map(async (entry) => ({ name: entry.name, text: await readFile(join(entry.parentPath, entry.name), 'utf8') })),
  )

test('a data folder from before config.json moves into it: files at start, secret setups at the first sign-in', async (t) => {
  const dir = await dataDir(t)
  const service = {
    baseUrl: 'https://notes.example.com/api',
    auth: { type: 'bearer', secret: 'notes' },
    read: 'ask',
    write: 'ask',
  }
  await writeFile(join(dir, 'services.json'), JSON.stringify({ notes: service }))
  await writeFile(join(dir, 'groups.json'), JSON.stringify({ ops: { items: ['notes.read'] } }))
  const old = { value: 'ghp-old-format', hosts: ['api.github.com'], env: 'GH_TOKEN' }
  const vault = { services: { notes: 'notes-key' }, secrets: { GITHUB_TOKEN: old }, ssh: await generateSshKey() }
  await createStore(join(dir, 'store.json'), ownerPassword, vault as unknown as Vault)
  const app = await start(dir)
  const config = async () => JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
  assert.deepEqual((await config()).services.notes, service)
  assert.deepEqual((await config()).groups, { ops: { items: ['notes.read'] } })
  assert.ok(!(await readdir(dir)).some((name) => ['services.json', 'groups.json'].includes(name)))
  assert.equal((await app.signIn()).status, 303)
  assert.deepEqual((await config()).secrets, { GITHUB_TOKEN: { hosts: ['api.github.com'], env: 'GH_TOKEN' } })
  assert.ok(!JSON.stringify(await config()).includes(old.value))
  assert.deepEqual((await openStore(join(dir, 'store.json'), ownerPassword)).vault.secrets, { GITHUB_TOKEN: old.value })
  assert.deepEqual((await openStore(join(dir, 'store.json.bak'), ownerPassword)).vault.secrets, { GITHUB_TOKEN: old })
})

test('the first visit sets the owner password, a restart asks for it again, and sessions are cookies only', async (t) => {
  const dir = await dataDir(t)
  const first = await start(dir)
  const setup = await (await first.call('/admin')).text()
  assert.match(setup, /Set the owner password/)
  assert.equal((await first.form('/admin/setup', { password: 'short', confirm: 'short' })).status, 400)
  assert.equal((await first.form('/admin/setup', { password: 'long enough 1', confirm: 'long enough 2' })).status, 400)

  const created = await first.form('/admin/setup', { password: ownerPassword, confirm: ownerPassword })
  assert.equal(created.status, 303)
  const attributes = created.headers.getSetCookie()[0]
  assert.match(attributes, /HttpOnly/i)
  assert.match(attributes, /SameSite=Strict/i)
  assert.doesNotMatch(attributes, /Secure/i)
  const secure = await first.form('/admin/signin', { password: ownerPassword }, { 'x-forwarded-proto': 'https' })
  assert.match(secure.headers.getSetCookie()[0], /Secure/i)
  const cookie = sessionCookie(created)
  assert.match(await (await first.call('/admin', { headers: { cookie } })).text(), /id="agents"/)
  // The password is set once; HTTP Basic is gone.
  assert.equal((await first.form('/admin/setup', { password: ownerPassword, confirm: ownerPassword })).status, 409)
  const basic = { authorization: `Basic ${Buffer.from(`admin:${ownerPassword}`).toString('base64')}` }
  assert.match(await (await first.call('/admin', { headers: basic })).text(), /Sign in/)
  // Without a session: forms are refused, pages go back to sign-in.
  assert.equal((await first.form('/admin/services/save', {})).status, 401)
  assert.equal((await first.call('/admin/log')).headers.get('location'), '/admin')

  const restarted = await start(dir)
  const page = await (await restarted.call('/admin', { headers: { cookie } })).text()
  assert.match(page, /Sign in/)
  assert.doesNotMatch(page, /id="agents"/)
  const signedIn = await restarted.signIn()
  assert.equal(signedIn.status, 303)
  assert.match(
    await (await restarted.call('/admin', { headers: { cookie: sessionCookie(signedIn) } })).text(),
    /id="agents"/,
  )
})

test('the log survives a restart and can be searched', async (t) => {
  const dir = await dataDir(t)
  const first = await start(dir)
  await setOwnerPassword(first.call)
  assert.equal((await first.enroll('tok')).status, 201)
  const restarted = await start(dir)
  const cookie = sessionCookie(await restarted.signIn())
  const page = async (query: string) => (await restarted.call(`/admin/log${query}`, { headers: { cookie } })).text()
  assert.match(await page(''), /agent enrolled/)
  assert.match(await page('?q=enrolled'), /agent enrolled/)
  assert.doesNotMatch(await page('?q=nothing-matches-this'), /agent enrolled/)
})

test('a wrong password is refused and sign-in is rate limited', async (t) => {
  const dir = await dataDir(t)
  await setOwnerPassword((await start(dir)).call)
  const restarted = await start(dir)
  for (let i = 0; i < 5; i++) {
    const refused = await restarted.signIn('not the password')
    assert.equal(refused.status, 401)
    assert.deepEqual(refused.headers.getSetCookie(), [])
    assert.match(await refused.text(), /Wrong password/)
  }
  assert.equal((await restarted.signIn()).status, 429)
  assert.equal((await restarted.enroll('tok')).status, 503)
})

test('agents and sandbox hosts get `locked` until the owner signs in', async (t) => {
  const dir = await dataDir(t)
  await setOwnerPassword((await start(dir)).call)
  const restarted = await start(dir)
  const bearer = { authorization: 'Bearer anything' }
  for (const [path, init] of [
    ['/_speaker/agents', { method: 'POST', body: '{}' }],
    ['/_speaker/hosts', { method: 'POST', body: '{}' }],
    ['/_speaker/catalog', { headers: bearer }],
    ['/demo/check', { headers: bearer }],
  ] as const) {
    const response = await restarted.call(path, init)
    assert.equal(response.status, 503, path)
    assert.deepEqual(await response.json(), locked, path)
  }
  assert.equal((await restarted.call('/_speaker/health')).status, 200)
  assert.equal((await restarted.call('/_speaker/help')).status, 200)
  assert.equal((await restarted.signIn()).status, 303)
  assert.equal((await restarted.enroll('tok')).status, 201)
})

test('until the owner has set a password, agent, host and proxy-certificate calls are refused', async (t) => {
  const fresh = await start(await dataDir(t))
  for (const [path, init] of [
    ['/_speaker/agents', { method: 'POST', body: '{}' }],
    ['/_speaker/hosts', { method: 'POST', body: '{}' }],
    ['/_speaker/catalog', { headers: { authorization: 'Bearer anything' } }],
  ] as const) {
    const response = await fresh.call(path, init)
    assert.equal(response.status, 503, path)
    assert.deepEqual(await response.json(), {
      error: 'locked',
      message: 'Speaker has no owner password yet',
      next: 'Wait until the owner has signed in, then repeat the call',
      tell_user: 'The owner sets one at http://localhost/admin',
    })
  }
  await setOwnerPassword(fresh.call)
  assert.equal((await fresh.enroll('tok')).status, 201)
})

test('keys and secrets are stored only encrypted, and come back after sign-in', async (t) => {
  const dir = await dataDir(t)
  const first = await start(dir)
  const cookie = { cookie: await setOwnerPassword(first.call) }
  const serviceKey = 'service-key-1f6c2a9e'
  const secretValue = 'ghp_secret_value_7d41b0'
  const saved = [
    await first.form(
      '/admin/services/save',
      {
        id: 'notes',
        baseUrl: 'https://notes.example.com/api',
        authType: 'bearer',
        secret: serviceKey,
        read: 'ask',
        write: 'ask',
      },
      cookie,
    ),
    await first.form(
      '/admin/secrets/save',
      { name: 'GITHUB_TOKEN', value: secretValue, hosts: 'api.github.com\ngithub.com', env: 'GH_TOKEN' },
      cookie,
    ),
  ]
  assert.deepEqual(
    saved.map((response) => response.status),
    [303, 303],
  )
  const incomplete = await first.form(
    '/admin/secrets/save',
    { name: 'EMPTY', value: '', hosts: 'a.example', env: 'E' },
    cookie,
  )
  assert.equal(incomplete.status, 400)

  const setup = async (signedIn: { cookie: string }) =>
    await (await first.call('/admin?section=services', { headers: signedIn })).text()
  const page = await setup(cookie)
  for (const shown of ['GITHUB_TOKEN', 'GH_TOKEN', 'api.github.com', 'github.com'])
    assert.ok(page.includes(shown), shown)
  assert.ok(!page.includes(secretValue) && !page.includes(serviceKey))

  // On disk: one encrypted store, no plaintext secret files, and none of the clear values anywhere.
  const names = await readdir(dir)
  assert.ok(names.includes('store.json') && !names.includes('secrets'))
  assert.equal((await stat(join(dir, 'store.json'))).mode & 0o777, 0o600)
  for (const { name, text } of await filesOf(dir))
    for (const clear of [serviceKey, secretValue, 'speaker-demo-credential', 'OPENSSH PRIVATE KEY'])
      assert.ok(!text.includes(clear), `${name} must not hold ${clear}`)

  const restarted = await start(dir)
  const back = await restarted.signIn()
  const after = await (
    await restarted.call('/admin?section=services', { headers: { cookie: sessionCookie(back) } })
  ).text()
  assert.match(after, /Credential[^>]*>Set</)
  assert.ok(after.includes('GITHUB_TOKEN') && !after.includes(secretValue))
})

test('changing the password re-wraps the keys: the old password stops working, the keys stay', async (t) => {
  const dir = await dataDir(t)
  const first = await start(dir)
  const cookie = { cookie: await setOwnerPassword(first.call) }
  const change = (current: string) =>
    first.form(
      '/admin/password',
      { current, password: 'a brand new password', confirm: 'a brand new password' },
      cookie,
    )
  assert.equal((await change('not the password')).status, 400)
  assert.equal((await change(ownerPassword)).status, 303)

  const restarted = await start(dir)
  assert.equal((await restarted.signIn()).status, 401)
  const back = await restarted.signIn('a brand new password')
  assert.equal(back.status, 303)
  const page = await (
    await restarted.call('/admin?section=services', { headers: { cookie: sessionCookie(back) } })
  ).text()
  assert.match(page, /Credential[^>]*>Set</)
})

test('the owner API: sign-in gives a bearer token that lists, approves, denies and revokes; the cookie is refused', async (t) => {
  const dir = await dataDir(t)
  await setOwnerPassword((await start(dir)).call)
  const s = await start(dir)
  const api = (path: string, token?: string, body?: object, headers: Record<string, string> = {}) =>
    s.call(`/admin/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const signIn = async (password = ownerPassword) => api('/signin', undefined, { password })

  // API sign-in failures count toward the form's lockout (5 in all), and the API sign-in unlocks speaker.
  for (let i = 0; i < 3; i++) assert.equal((await signIn('wrong')).status, 401)
  assert.equal((await s.enroll('tok')).status, 503)
  const signedIn = await signIn()
  assert.equal(signedIn.status, 200)
  const { token, publicUrl } = (await signedIn.json()) as { token: string; publicUrl: string }
  assert.match(publicUrl, /^https?:\/\//) // where the mod's "Open in browser" goes
  assert.equal((await s.enroll('tok')).status, 201)

  // Only the bearer token opens /admin/api: no token, a wrong one, or the session cookie get 401 in the error shape.
  const cookie = sessionCookie(await s.signIn())
  for (const response of [
    await api('/pending'),
    await api('/pending', 'not-a-token'),
    await api('/pending', undefined, undefined, { cookie }),
    await api('/pending', cookie.split('=')[1]),
    await api('/requests/x/deny', undefined, {}, { cookie, origin: 'http://localhost' }),
  ]) {
    assert.equal(response.status, 401)
    assert.equal(((await response.json()) as { error: string }).error, 'denied')
  }
  // And the token is no session cookie.
  assert.match(await (await s.call('/admin', { headers: { cookie: `speaker_session=${token}` } })).text(), /Sign in/)

  const blocked = async () => {
    const response = await s.call('/demo/x', { method: 'POST', headers: { authorization: 'Bearer tok' } })
    assert.equal(response.status, 403)
    return ((await response.json()) as { request: string }).request
  }
  type Pending = {
    id: string
    who: { label: string }
    items: { item: string; risk?: string }[]
    reason: string
    duration: string
  }
  const pending = async () => ((await (await api('/pending', token)).json()) as { pending: Pending[] }).pending
  const first = await blocked()
  assert.deepEqual(
    (await pending()).map((r) => [r.id, r.who.label, r.items.map((i) => [i.item, i.risk])]),
    [[first, 'tok', [['demo.full', 'read/write']]]],
  )
  assert.equal((await api(`/requests/${first}/approve`, token, { duration: '30m' })).status, 204)
  assert.equal((await api(`/requests/${first}/approve`, token, { duration: '30m' })).status, 409)
  assert.deepEqual(await pending(), [])
  const { grants } = (await (await api('/active', token)).json()) as { grants: { id: string; item: string }[] }
  assert.deepEqual(
    grants.map((g) => g.item),
    ['demo.full'],
  )
  assert.equal((await api(`/grants/${grants[0].id}/revoke`, token, {})).status, 204)
  assert.deepEqual(((await (await api('/active', token)).json()) as { grants: [] }).grants, [])
  assert.equal((await api(`/grants/${grants[0].id}/revoke`, token, {})).status, 404)

  const second = await blocked()
  assert.equal((await api(`/requests/${second}/deny`, token, {})).status, 204)
  assert.deepEqual(await pending(), [])
  // The same audit line the form decision writes.
  const log = await (await s.call(`/admin/log?q=${second}`, { headers: { cookie } })).text()
  assert.match(log, /request decided/)
})

test('failed owner API sign-ins and form sign-ins share one lockout', async (t) => {
  const dir = await dataDir(t)
  await setOwnerPassword((await start(dir)).call)
  const s = await start(dir)
  const apiSignIn = (password: string) =>
    s.call('/admin/api/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
  for (let i = 0; i < 3; i++) assert.equal((await apiSignIn('wrong')).status, 401)
  for (let i = 0; i < 2; i++) assert.equal((await s.signIn('wrong')).status, 401)
  assert.equal((await s.signIn()).status, 429)
  assert.equal((await apiSignIn(ownerPassword)).status, 429)
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCore, type Agent } from '../core.ts'
import { readConfig } from '../server.ts'
import { freePorts } from './owner.ts'

test('a host titles only its own agents, and the title reaches the view', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'speaker-test-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const core = await createCore(
    readConfig({ DATA_DIR: dataDir, PUBLIC_URL: 'http://localhost', ...(await freePorts()) }),
  )
  t.after(() => core.jump.stop())
  const add = (id: string, host?: string) =>
    core.agents.set(id, { id, status: 'enrolled', label: id, host, counts: {} } as unknown as Agent)
  add('mine', 'host-a')
  add('theirs', 'host-b')
  add('direct')
  core.setTitles('host-a', { mine: 'Compare costs', theirs: 'Hijack', direct: 'Hijack', nobody: 'x' })
  const titles = Object.fromEntries(core.view().agents.map((agent) => [agent.id, agent.title]))
  assert.deepEqual(titles, { mine: 'Compare costs', theirs: undefined, direct: undefined })
})

// Host-entry check: a local session probes this machine, a remote session
// probes through rw_exec as its own agent, and settings shows the last one.
// Run with:
//   node tools/test-host.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-gpu-host-'))
const localCwd = path.join(home, 'local-project')
const mirrorDir = path.join(home, 'remote-workspaces', 'gpu-lab-alice-2222', 'proj')
mkdirSync(localCwd, { recursive: true })
mkdirSync(mirrorDir, { recursive: true })
writeFileSync(path.join(mirrorDir, '.dsh-remote-meta.json'), JSON.stringify({
  host: '10.0.0.5',
  port: 2222,
  username: 'alice',
  remotePath: '/home/alice/proj',
}))
process.env.DSH_HOME = home

const remoteOutput = `==DSHGPU host==
gpu-lab
==DSHGPU backend==
nvidia-smi
==DSHGPU gpus==
0, Test GPU A, 80, 12000, 16000
1, Test GPU B, 2, 100, 16000
==DSHGPU temp==
0, 70
1, 35
==DSHGPU end==`

const agents = new Map([
  ['s-local', { id: 's-local', session: { header: { cwd: localCwd } } }],
  ['s-remote', { id: 's-remote', session: { header: { cwd: mirrorDir } } }],
])
const services = { agents, sessions: { get: () => undefined } }
const routes = []
let remoteCalls = 0
let lastRemoteAgent = null
let registeredTool = null

// Stands in for dsh-remote's rw_exec: the plugin must call its body directly
// (a registry batch would run outside the session log the auto-review gate reads).
const rwExec = {
  name: 'rw_exec',
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] },
  async execute(_args, exec) {
    remoteCalls += 1
    lastRemoteAgent = exec.agent
    return { text: remoteOutput }
  },
}
const tools = {
  register(definition) { registeredTool = definition; return () => {} },
  executable(name, agent) { return name === 'rw_exec' && agent ? rwExec : undefined },
  async execute() { throw new Error('the plugin must not route rw_exec through tools.execute') },
}

const ctx = {
  tools,
  effect(fn) { return fn() },
  get(name) { return services[name] },
  inject(_deps, callback) {
    const inner = {
      get: (name) => services[name],
      effect: (fn) => fn(),
    }
    return callback(inner)
  },
}

const webServer = {
  register(route) { routes.push(route); return () => {} },
}
const connection = {
  requestRejection() { return undefined },
  fetch: { register() { return () => {} } },
}
services.webServer = webServer
services.connection = connection

apply(ctx, { intervalMs: 60000, commandTimeoutMs: 5000 })

assert.equal(routes.length, 1, 'one GPU route is registered')
const route = routes[0]

async function query(sessionId) {
  const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
  const req = { url: `/dsh-remote-gpu-switch/gpu${suffix}`, headers: {} }
  let body = ''
  const res = {
    statusCode: 200,
    setHeader() {},
    end(value) { body = String(value) },
  }
  await route.handler(req, res)
  return JSON.parse(body)
}

try {
  // LOCAL workspace: runs on this machine; with no GPU tool that is a clean
  // "ok, no backend" sample rather than an error.
  const local = await query('s-local')
  assert.equal(local.target.kind, 'local')
  assert.equal(local.local, true)
  assert.equal(local.status, 'ok')
  assert.equal(local.gpus.length, 0)
  assert.ok(local.error === 'no-gpu-backend' || local.error === 'no-gpu-visible',
    `expected a no-GPU reason, got ${local.error}`)
  assert.equal(remoteCalls, 0, 'a local workspace must not call rw_exec')

  // REMOTE workspace: same display logic, but resolved through rw_exec as the
  // session's own agent so dsh-remote picks this workspace's host.
  const remote = await query('s-remote')
  assert.equal(remoteCalls, 1)
  assert.equal(lastRemoteAgent?.id, 's-remote')
  assert.equal(remote.target.kind, 'remote')
  assert.equal(remote.target.address, 'alice@10.0.0.5:2222')
  assert.equal(remote.backend, 'nvidia-smi')
  assert.equal(remote.gpus.length, 2)
  assert.equal(remote.idle.total, 2)
  assert.equal(remote.idle.count, 1)

  // Settings (no session): the last viewed machine, not an unrelated active host.
  const settings = await query('')
  assert.equal(settings.target.kind, 'remote')
  assert.equal(settings.target.address, 'alice@10.0.0.5:2222')

  // The agent tool resolves the same session workspace, not a global machine.
  assert.ok(registeredTool, 'remote_gpu tool is registered')
  const text = (await registeredTool.execute({}, { agent: agents.get('s-remote') })).text
  assert.match(text, /Remote host alice@10\.0\.0\.5:2222/)
  assert.match(text, /Idle GPUs: 1\/2/)

  console.log('ALL PASS local / remote / last-context / tool routing')
} finally {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
}

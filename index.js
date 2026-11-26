// dsh-remote-gpu-switch — host half.
//
// Reports live GPU utilization of the machine the current workspace belongs to:
// a LOCAL workspace probes this host directly, a REMOTE workspace keeps using
// dsh-remote's own `rw_exec` tool against the host recorded in that workspace's
// mirror. The probe is therefore always the machine the user is working on,
// and switching workspaces switches machines.
//
// Remote probes run through dsh-remote's `rw_exec` on behalf of the calling
// session's agent, so dsh-remote resolves the same mirror-bound host as the
// session's own tools: no second SSH connection, no credentials, no active
// machine fallback. The host keeps one sample per machine (local / each remote
// origin), refreshes it on a timer while a client watches, and serves it as
// JSON over the plugin's own HTTP route.

import { execFile } from 'node:child_process'
import { registerHttpTransports } from './lib/http-transport.js'
import { parseGpuOutput, toWireGpu } from './lib/gpu-parse.js'
import {
  findMirrorForCwd,
  machineKey,
  remoteWorkspacesRoot,
  targetKeyForMirror,
} from './lib/workspace-target.js'

export const name = 'dsh-remote-gpu-switch'
export const inject = ['tools']

/**
 * One POSIX shell line, tolerant of missing tools:
 *   ==DSHGPU host==    → hostname
 *   ==DSHGPU backend== → nvidia-smi | rocm-smi | gpustat | none
 *   ==DSHGPU gpus==    → backend-specific payload
 *   ==DSHGPU temp==    → optional per-GPU temperature (NVIDIA only)
 *   ==DSHGPU uuid==    → index,uuid per GPU (NVIDIA only)
 *   ==DSHGPU procs==   → pid,gpu_uuid,used_memory of the compute apps (NVIDIA only)
 *   ==DSHGPU ps==      → pid,user,command of those processes (NVIDIA only)
 * Each fragment ends with `;` so the fragments join with a plain space: a `;`
 * right after `then`/`else` would not parse. The same script runs on the local
 * host through `sh -c` and on remote hosts through dsh-remote.
 */
const DEFAULT_COMMAND = [
  "echo '==DSHGPU host==';",
  'hostname 2>/dev/null || uname -n 2>/dev/null || echo unknown;',
  "echo '==DSHGPU backend==';",
  "if command -v nvidia-smi >/dev/null 2>&1; then echo nvidia-smi; echo '==DSHGPU gpus==';"
    + ' nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total'
    + ' --format=csv,noheader,nounits 2>/dev/null;'
    + " echo '==DSHGPU temp==';"
    + ' nvidia-smi --query-gpu=index,temperature.gpu --format=csv,noheader,nounits 2>/dev/null;'
    + " echo '==DSHGPU uuid==';"
    + ' nvidia-smi --query-gpu=index,uuid --format=csv,noheader,nounits 2>/dev/null;'
    + " echo '==DSHGPU procs==';"
    + ' CA=$(nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory'
    + ' --format=csv,noheader,nounits 2>/dev/null);'
    + ' echo "$CA";'
    + " echo '==DSHGPU ps==';"
    + ' for p in $(echo "$CA" | cut -d, -f1 | tr -d \' \' | sort -u); do'
    + ' o=$(ps -o user=,comm= -p "$p" 2>/dev/null | tr -s \' \' | tr \' \' \',\');'
    + ' echo "$p,${o:-?}";'
    + ' done;',
  "elif command -v rocm-smi >/dev/null 2>&1; then echo rocm-smi; echo '==DSHGPU gpus==';"
    + ' rocm-smi --showuse --showmemuse --showtemp --json 2>/dev/null;',
  "elif command -v gpustat >/dev/null 2>&1; then echo gpustat; echo '==DSHGPU gpus==';"
    + ' gpustat --json 2>/dev/null;',
  'else echo none; fi;',
  "echo '==DSHGPU end=='",
].join(' ')

const DEFAULTS = {
  intervalMs: 3000,
  commandTimeoutMs: 15000,
  idleStopMs: 120000,
  historyLength: 90,
  idleUtilPercent: 10,
  idleMemoryPercent: 5,
}

/**
 * Is this GPU free enough to hand out to a new job?
 *
 * A card counts as idle when it barely draws power *and* barely holds memory:
 * a model that is loaded but waiting still owns the VRAM, so it is not free.
 * @param {object} gpu - one wire GPU sample.
 * @param {object} settings - the resolved plugin settings.
 * @returns {boolean} true when the card counts as idle.
 */
function isIdleGpu(gpu, settings) {
  const utilization = typeof gpu.utilization === 'number' ? gpu.utilization : null
  const memoryPercent = typeof gpu.memoryPercent === 'number' ? gpu.memoryPercent : null
  if (utilization !== null && utilization >= settings.idleUtilPercent) return false
  if (memoryPercent !== null && memoryPercent >= settings.idleMemoryPercent) return false
  return true
}

/**
 * Coerce the row config into usable settings.
 * @param {any} config - the raw `config` block of the plugin row.
 */
function resolveSettings(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const number = (value, fallback, min, max) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, parsed))
  }
  const custom = (value) => typeof value === 'string' && value.trim() !== ''
  return {
    intervalMs: number(raw.intervalMs, DEFAULTS.intervalMs, 500, 300000),
    commandTimeoutMs: number(raw.commandTimeoutMs, DEFAULTS.commandTimeoutMs, 1000, 300000),
    idleStopMs: number(raw.idleStopMs, DEFAULTS.idleStopMs, 0, 3600000),
    historyLength: number(raw.historyLength, DEFAULTS.historyLength, 10, 600),
    idleUtilPercent: number(raw.idleUtilPercent, DEFAULTS.idleUtilPercent, 0, 100),
    idleMemoryPercent: number(raw.idleMemoryPercent, DEFAULTS.idleMemoryPercent, 0, 100),
    command: custom(raw.command) ? raw.command : DEFAULT_COMMAND,
    // Remote-only overrides must not leak into the local probe (and vice versa).
    localCommand: custom(raw.localCommand) ? raw.localCommand : DEFAULT_COMMAND,
  }
}

/**
 * Turn a failure into a message plus an actionable hint.
 * @param {string} message - raw failure text.
 */
function describeFailure(message) {
  const text = String(message ?? '').trim() || 'unknown error'
  if (/ToolNotFound|not found|no such tool/i.test(text)) {
    return {
      message: 'dsh-remote is not available: the rw_exec tool is missing.',
      hint: 'Install and enable the dsh-remote plugin, then reconnect.',
    }
  }
  if (/no remote workspace set/i.test(text)) {
    return {
      message: 'dsh-remote has no remote workspace selected.',
      hint: 'Pick a remote workspace (rw_pick_workspace) in dsh-remote first.',
    }
  }
  if (/no remote host resolved/i.test(text)) {
    return {
      message: 'dsh-remote has no remote host connected.',
      hint: 'Connect to a server first (rw_connect).',
    }
  }
  if (/this session is LOCAL/i.test(text)) {
    return { message: text, hint: 'The probe targets the machine of the current workspace.' }
  }
  if (/timed out/i.test(text)) {
    return { message: text, hint: 'The remote probe timed out; raise commandTimeoutMs if needed.' }
  }
  if (/not live|no session context/i.test(text)) {
    return {
      message: 'The current workspace is not attached to a live session.',
      hint: 'Reopen the workspace session and try again.',
    }
  }
  return { message: text, hint: null }
}

/**
 * Run the probe script on this machine (a LOCAL workspace).
 * @param {string} command - POSIX shell script.
 * @param {number} timeoutMs - hard timeout.
 * @returns {Promise<string>} script stdout.
 */
function runLocalProbe(command, timeoutMs) {
  // On Windows the script uses POSIX shell syntax; Git Bash's `sh` is the
  // only runner that understands it. Without it, report a real error rather
  // than pretending the machine has no GPU.
  const shell = process.platform === 'win32' ? 'sh' : '/bin/sh'
  // A GUI/daemon process often lacks the interactive shell's PATH; GPU tools
  // commonly live in /usr/local/bin or Homebrew's prefix.
  const pathEnv = process.platform === 'win32'
    ? (process.env.PATH || process.env.Path || '')
    : ['/usr/local/bin', '/opt/homebrew/bin', process.env.PATH || ''].join(':')
  return new Promise((resolve, reject) => {
    execFile(shell, ['-c', command], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PATH: pathEnv, LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      // A non-zero exit still yields a usable marked payload (e.g. a backend
      // that reports a driver error); only a spawn failure with no output is
      // a real local-probe failure.
      if (error && !String(stdout || '').trim()) {
        const detail = String(stderr || '').trim() || error.message
        reject(new Error(error.code === 'ENOENT'
          ? `local shell not available: ${shell}`
          : detail))
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

/**
 * Summarize the distinct users across every GPU of the host.
 * @param {object[]} gpus - wire samples.
 * @returns {object[]} user entries, heaviest first.
 */
function summarizeUsers(gpus) {
  const map = new Map()
  for (const gpu of gpus ?? []) {
    for (const entry of gpu.users ?? []) {
      const current = map.get(entry.user) ?? { user: entry.user, count: 0, memory: 0, gpus: 0 }
      current.count += entry.count
      current.memory += entry.memory
      current.gpus += 1
      map.set(entry.user, current)
    }
  }
  return [...map.values()].sort((left, right) => right.count - left.count || right.memory - left.memory)
}

/**
 * Render the current sample as plain text (used by the agent tool).
 * @param {object} snapshot - the served snapshot.
 */
function formatSnapshot(snapshot) {
  const target = snapshot.target || {}
  const where = target.kind === 'local'
    ? `Local host ${snapshot.host || 'unknown'}`
    : `Remote host ${target.address || snapshot.host || 'unknown'}`
  if (snapshot.status === 'error') {
    const hint = snapshot.hint ? `\n${snapshot.hint}` : ''
    return `${where}: GPU probe failed: ${snapshot.error}${hint}`
  }
  if (snapshot.status !== 'ok') return `${where}: GPU probe has not produced a sample yet.`
  if (!snapshot.gpus.length) return `${where}: no GPU visible (${snapshot.backend}).`
  const lines = [`${where} — ${snapshot.backend}`]
  if (snapshot.idle) {
    lines.push(`Idle GPUs: ${snapshot.idle.count}/${snapshot.idle.total} (util < ${snapshot.idle.utilPercent}%, memory < ${snapshot.idle.memoryPercent}%)`)
  }
  for (const gpu of snapshot.gpus) {
    const parts = [`GPU ${gpu.index} ${gpu.name}`]
    parts.push(`util ${gpu.utilization === null ? 'n/a' : `${gpu.utilization}%`}`)
    if (gpu.memoryUsed !== null && gpu.memoryTotal !== null) {
      parts.push(`memory ${gpu.memoryUsed}/${gpu.memoryTotal} MiB`)
    }
    if (gpu.temperature !== null) parts.push(`temp ${gpu.temperature}°C`)
    if (gpu.idle) parts.push('idle')
    if (gpu.users && gpu.users.length > 0) {
      parts.push(`users ${gpu.users.map((entry) => `${entry.user}×${entry.count}`).join(', ')}`)
    }
    lines.push(parts.join(' · '))
  }
  if (snapshot.users && snapshot.users.length > 0) {
    lines.push(`Active users: ${snapshot.users.map((entry) => `${entry.user} (${entry.count} proc, ${entry.gpus} GPU)`).join(', ')}`)
  }
  if (snapshot.requests > 0) lines.push(`(GPU panel polled ${snapshot.requests}×)`)
  return lines.join('\n')
}

/**
 * Host plugin entry point.
 * @param {any} ctx - plugin context.
 * @param {any} config - the `config` block of the plugin row.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)

  /** One sample holder per machine (`local`, `remote:user@host:port`) or the legacy active machine. */
  const contexts = new Map()
  let lastContext = null
  let legacyContext = null
  let callSeq = 0
  // The tool registry fuses the caller signal with the wrapper signal and reads
  // `signal.aborted` unguarded, so every execution needs a real AbortSignal.
  // One controller per plugin lifetime also cancels a running probe on unload.
  const abort = new AbortController()

  /**
   * A fresh sample holder.
   * @param {string} key - context key.
   */
  function createContext(key) {
    return {
      key,
      target: null,
      status: 'idle',
      host: '',
      backend: 'none',
      gpus: [],
      error: null,
      hint: null,
      updatedAt: 0,
      // How often a client asked for this machine — proof that the UI is wired.
      requests: 0,
      history: [],
      lastRequestAt: 0,
      timer: null,
      inFlight: null,
    }
  }

  /**
   * The holder for one machine, created on first request.
   * @param {string} key - context key.
   */
  function contextFor(key) {
    let context = contexts.get(key)
    if (!context) {
      context = createContext(key)
      contexts.set(key, context)
    }
    return context
  }

  ctx.effect(() => () => {
    for (const context of contexts.values()) {
      if (context.timer !== null) {
        clearInterval(context.timer)
        context.timer = null
      }
    }
    try { abort.abort() } catch { /* already aborted */ }
  }, 'dsh-remote-gpu-switch.timer')

  /**
   * Resolve the machine the given session's workspace belongs to.
   *
   * No session id means "no workspace context": keep the original behaviour and
   * target the active dsh-remote machine. A session whose cwd is inside a
   * dsh-remote mirror is remote (bound to that mirror's host); any other cwd is
   * a local workspace.
   *
   * @param {string} [sessionId] - the calling session.
   * @returns {{key: string, kind: 'local'|'remote'|'legacy'|'unknown',
   *   sessionId: string, cwd?: string, agent?: any, mirror?: object}}
   */
  function resolveTarget(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) return { key: 'legacy', kind: 'legacy', sessionId: '' }
    const get = typeof ctx.get === 'function' ? (name) => ctx.get(name) : () => undefined
    const agents = get('agents')
    const agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined
    const sessions = get('sessions')
    let cwd = ''
    try { cwd = String(agent?.session?.header?.cwd || '') } catch { cwd = '' }
    if (!cwd && sessions && typeof sessions.get === 'function') {
      try { cwd = String(sessions.get(id)?.header?.cwd || '') } catch { cwd = '' }
    }
    if (!cwd) return { key: `session:${id}`, kind: 'unknown', sessionId: id, agent }
    const mirror = findMirrorForCwd(cwd, remoteWorkspacesRoot())
    if (!mirror) return { key: 'local', kind: 'local', sessionId: id, cwd, agent }
    return {
      key: targetKeyForMirror(mirror),
      kind: 'remote',
      sessionId: id,
      cwd,
      agent,
      mirror,
    }
  }

  /**
   * The target as the client renders it — host identity, not GPU identity.
   * @param {object} target - from {@link resolveTarget}.
   * @param {object} context - sample holder (for the probed hostname).
   */
  function publicTarget(target, context) {
    if (target.kind === 'local') {
      return { kind: 'local', label: 'local', hostname: context.host || '', cwd: target.cwd || '' }
    }
    if (target.kind === 'remote') {
      const mirror = target.mirror || {}
      return {
        kind: 'remote',
        label: mirror.alias || mirror.host || '',
        address: machineKey(mirror),
        host: mirror.host || '',
        port: Number(mirror.port) || 22,
        username: mirror.username || '',
        hostname: context.host || '',
      }
    }
    if (target.kind === 'unknown') return { kind: 'unknown', label: '', hostname: context.host || '' }
    return { kind: 'remote', label: 'dsh-remote', address: context.host || '', hostname: context.host || '', legacy: true }
  }

  /**
   * Merge a parsed probe into a context.
   * @param {object} context - sample holder.
   * @param {object} parsed - {@link parseGpuOutput} result.
   * @param {object} target - from {@link resolveTarget}.
   */
  function applyParsed(context, parsed, target) {
    context.status = 'ok'
    context.host = parsed.host
    context.backend = parsed.backend
    context.gpus = parsed.gpus.map(toWireGpu)
    context.error = parsed.error
    const local = target.kind === 'local'
    context.hint = local && parsed.error === 'no-gpu-backend'
      ? 'No nvidia-smi / rocm-smi / gpustat was found on this machine.'
      : local && parsed.error === 'no-gpu-visible'
        ? (parsed.detail
          ? `The local probe tool reported: ${parsed.detail}`
          : 'The local probe tool exists but reports no visible GPU.')
        : parsed.error === 'no-gpu-backend'
          ? 'Neither nvidia-smi, rocm-smi nor gpustat was found on the remote host.'
          : parsed.error === 'no-gpu-visible'
            ? (parsed.detail
              ? `The probe tool reported: ${parsed.detail}`
              : 'The probe tool exists but reports no visible GPU.')
            : null
    context.updatedAt = Date.now()
    pushHistory(context)
  }

  /** Append one sample to a machine's sparkline history. */
  function pushHistory(context) {
    const utilization = context.gpus.reduce((max, gpu) => {
      const value = gpu.utilization
      return typeof value === 'number' && value > max ? value : max
    }, 0)
    context.history.push({ t: context.updatedAt, util: utilization })
    while (context.history.length > settings.historyLength) context.history.shift()
  }

  /**
   * Run the probe for one machine.
   *
   * Remote targets execute `rw_exec` as the calling session's own agent, which
   * makes dsh-remote resolve the workspace's mirror-bound host instead of the
   * mutable active machine. Local targets run the same script through `sh`.
   *
   * @param {object} context - sample holder.
   * @param {object} target - from {@link resolveTarget}.
   * @returns {Promise<void>}
   */
  function probe(context, target) {
    if (context.inFlight !== null) return context.inFlight
    context.target = target
    context.inFlight = (async () => {
      try {
        let text = ''
        if (target.kind === 'unknown') {
          // A blank session has no workspace yet: nothing to probe is a fact, not a failure.
          context.status = 'ok'
          context.host = ''
          context.backend = 'none'
          context.gpus = []
          context.error = null
          context.hint = 'No workspace yet — open a workspace to see its GPUs.'
          context.updatedAt = Date.now()
          return
        }
        if (target.kind === 'local') {
          text = await runLocalProbe(settings.localCommand, settings.commandTimeoutMs)
        } else {
          if (target.kind === 'remote' && !target.agent) {
            throw new Error('session is not live — reopen the workspace session to probe its remote host')
          }
          // The registry looks the tool up by the agent's SCOPE KEY, so pass
          // the agent itself, never its id.
          const tool = typeof ctx.tools.executable === 'function'
            ? ctx.tools.executable('rw_exec', target.agent)
            : undefined
          if (!tool) {
            throw new Error('rw_exec is not available for this session — install and enable dsh-remote')
          }
          // Call the tool body directly. Going through `ctx.tools.execute` would
          // re-run a batch WITHOUT the call ever being logged as `tool/call` in
          // the session, which is exactly what the auto-review gate rejects
          // ("the pending root call is missing or ambiguous in the session log").
          // dsh-remote resolves the host from `exec.agent.session`, which is what
          // selects the workspace's own mirror-bound machine.
          callSeq += 1
          const callId = `dsh-remote-gpu-switch-${Date.now().toString(36)}-${callSeq}`
          const exec = {
            callId,
            rootCallId: callId,
            name: 'rw_exec',
            arguments: {
              command: settings.command,
              // `rw_exec` promotes a timed-out command to a background job by
              // default, and that path calls `jobs.start({ owner: agent?.id })`.
              // A probe has no turn to attach a job to, so opt out entirely.
              promoteOnTimeout: false,
              // Fail the call ourselves rather than inheriting a longer budget.
              timeoutMs: Math.min(600000, Math.max(1000, settings.commandTimeoutMs)),
            },
            signal: abort.signal,
            agent: target.agent,
            deferContext() {},
            concludeTurn() {},
          }
          let result
          try {
            result = await tool.execute(exec.arguments, exec)
          } catch (error) {
            throw new Error(error instanceof Error ? error.message : String(error))
          }
          if (result && typeof result.text === 'string') {
            // The tool declares an output schema: its rendered text is the
            // marker-delimited probe output.
            text = result.text
          } else if (Array.isArray(result?.content)) {
            text = result.content.map((block) => (block && block.type === 'text' ? block.text : '')).join('\n')
          }
        }
        applyParsed(context, parseGpuOutput(text), target)
      } catch (error) {
        // The batch executor wraps scheduler failures in a generic
        // "Tool batch execution failed"; the real reason is on `cause`.
        const own = error instanceof Error ? error.message : String(error)
        const cause = error?.cause instanceof Error ? error.cause.message : null
        const failure = describeFailure(cause ? `${own} (${cause})` : own)
        context.status = 'error'
        context.error = failure.message
        context.hint = failure.hint
        context.updatedAt = Date.now()
      } finally {
        context.inFlight = null
      }
    })()
    return context.inFlight
  }

  /** Start a machine's refresh timer when a client starts watching it. */
  function ensureTimer(context) {
    if (context.timer !== null) return
    context.timer = setInterval(() => {
      if (settings.idleStopMs > 0 && Date.now() - context.lastRequestAt > settings.idleStopMs) {
        clearInterval(context.timer)
        context.timer = null
        return
      }
      if (context.target) void probe(context, context.target)
    }, settings.intervalMs)
    if (typeof context.timer.unref === 'function') context.timer.unref()
  }

  /**
   * The JSON payload the client renders.
   * @param {object} context - sample holder.
   * @returns {object} snapshot.
   */
  function snapshot(context) {
    const target = context.target
    const gpus = context.gpus.map((gpu) => ({ ...gpu, idle: isIdleGpu(gpu, settings) }))
    return {
      status: context.status,
      target: target ? publicTarget(target, context) : null,
      local: target ? target.kind === 'local' : false,
      host: context.host,
      backend: context.backend,
      gpus,
      users: summarizeUsers(context.gpus),
      idle: {
        count: gpus.filter((gpu) => gpu.idle).length,
        total: gpus.length,
        utilPercent: settings.idleUtilPercent,
        memoryPercent: settings.idleMemoryPercent,
      },
      error: context.error,
      hint: context.hint,
      updatedAt: context.updatedAt,
      requests: context.requests,
      intervalMs: settings.intervalMs,
      command: target && target.kind === 'local' ? settings.localCommand : settings.command,
      history: context.history.slice(-settings.historyLength),
    }
  }

  /**
   * Serve one machine's snapshot, probing it when stale or never sampled.
   * @param {object} context - sample holder.
   * @param {object} target - from {@link resolveTarget}.
   */
  async function serve(context, target) {
    const now = Date.now()
    context.target = target
    context.lastRequestAt = now
    context.requests += 1
    lastContext = context
    ensureTimer(context)
    const stale = context.updatedAt === 0 || now - context.updatedAt > settings.intervalMs
    if (stale) {
      const pending = probe(context, target)
      // The very first caller waits for the sample; later callers get the
      // cached one right away and the refresh lands in the background.
      if (context.updatedAt === 0) await pending
    }
    return snapshot(context)
  }

  const routes = [
    {
      path: '/dsh-remote-gpu-switch/gpu',
      methods: ['GET'],
      requestBody: 'buffered',
      async handler(req, res) {
        let body
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          const sessionId = (url.searchParams.get('sessionId') || '').trim()
          if (sessionId) {
            const target = resolveTarget(sessionId)
            body = await serve(contextFor(target.key), target)
          } else if (lastContext) {
            // Settings has no session; show the machine the user was last
            // looking at instead of an unrelated active machine.
            body = await serve(lastContext, lastContext.target)
          } else {
            if (!legacyContext) legacyContext = contextFor('legacy')
            body = await serve(legacyContext, { key: 'legacy', kind: 'legacy', sessionId: '' })
          }
        } catch (error) {
          body = {
            status: 'error',
            target: null,
            local: false,
            host: '',
            backend: 'none',
            gpus: [],
            users: [],
            idle: { count: 0, total: 0, utilPercent: settings.idleUtilPercent, memoryPercent: settings.idleMemoryPercent },
            error: error instanceof Error ? error.message : String(error),
            hint: null,
            updatedAt: Date.now(),
            requests: 0,
            intervalMs: settings.intervalMs,
            command: settings.command,
            history: [],
          }
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(body))
      },
    },
  ]

  registerHttpTransports(ctx, routes)

  ctx.effect(() => ctx.tools.register({
    name: 'remote_gpu',
    description:
      'Live GPU utilization of the machine the current workspace belongs to: a local workspace probes '
      + 'this host, a remote workspace probes its dsh-remote host. Returns per-GPU compute load, memory '
      + 'usage, temperature, the host and the users whose processes occupy each GPU. Use it to check '
      + 'whether the GPU of the current workspace is busy, idle, hot or out of memory, and who is using it.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'Human readable GPU summary.' },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
    },
    async execute(_args, exec) {
      const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
      const target = resolveTarget(sessionId)
      const context = contextFor(target.key)
      await probe(context, target)
      context.lastRequestAt = Date.now()
      context.requests += 1
      lastContext = context
      return { text: formatSnapshot(snapshot(context)) }
    },
  }), 'dsh-remote-gpu-switch.tool')
}

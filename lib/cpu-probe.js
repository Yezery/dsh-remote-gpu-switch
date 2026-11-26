// dsh-remote-gpu-switch — the CPU fallback (unified memory, integrated GPUs).
//
// Two questions, one answer each:
//
//   • Does the CPU share memory with a GPU it can actually compute on? That is
//     Apple Silicon (Metal/MPS over unified memory) and an integrated GPU that
//     reports "shared memory" — both answer "yes", and the memory is then
//     usable as "VRAM" by a job, which is why a Mac without nvidia-smi is not
//     "no GPU".
//   • Otherwise: is there any GPU at all? No → "no usable GPU"; an integrated
//     GPU without a share figure → "no VRAM to read from the CPU".
//
// The probe only runs while the CPU view is enabled (off by default), so a
// GPU machine never pays for it. Nothing here touches the network.

import { execFile } from 'node:child_process'
import os from 'node:os'

/**
 * Run one shell script on this machine.
 * @param {string} script - POSIX shell script.
 * @param {number} timeoutMs - hard timeout.
 * @returns {Promise<string>} stdout (empty when the shell is missing).
 */
function runShell(script, timeoutMs) {
  const shell = process.platform === 'win32' ? 'sh' : '/bin/sh'
  return new Promise((resolve) => {
    execFile(shell, ['-c', script], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C' },
    }, (_error, stdout) => resolve(String(stdout || '')))
  })
}

/** Parse `key: value` lines into a flat record. */
function parsePairs(text) {
  const out = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key === '' || key in out) continue
    out[key] = line.slice(at + 1).trim()
  }
  return out
}

/**
 * What the CPU can see, on this machine.
 *
 * @param {{timeoutMs: number, topProcesses: number, maxMemoryMiB?:
 *   number|null}} options - probe limits. `maxMemoryMiB` marks a remote host,
 *   where process-level CPU cost is not collected.
 * @returns {Promise<{cpu: object, gpus: object[]}>} wire-ready device(s) plus
 *   the CPU summary the snapshot carries.
 */
export async function probeCpu(options) {
  const base = {
    model: os.cpus()[0]?.model?.trim() || 'CPU',
    cores: os.cpus().length,
    memTotal: Math.round(os.totalmem() / 1048576),
    memFree: Math.round(os.freemem() / 1048576),
  }
  const results = {}

  if (process.platform === 'darwin') {
    // Apple Silicon answers "shares memory with a GPU": unified memory is what
    // Metal/MPS hands out. The Intel Mac answers "no": its GPUs are discrete.
    const out = await runShell(
      'sysctl -n machdep.cpu.brand_string hw.ncpu'
      + ' hw.memsize hw.pagesize; vm_stat',
      options.timeoutMs,
    )
    const [brand, ncpu, memsize, pagesize, ...vm] = String(out).split(/\r?\n/)
    const num = (value) => {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null
    }
    const page = num(pagesize) || 4096
    let available = 0
    for (const line of vm) {
      if (!/^Pages (free|inactive)|^Pages occupied by compressor/.test(line)) continue
      const count = Number(/:\s+([\d.]+)/.exec(line)?.[1])
      if (Number.isFinite(count)) available += count
    }
    const total = num(memsize)
    if (brand && brand.trim()) base.model = brand.trim()
    if (num(ncpu)) base.cores = num(ncpu)
    if (total) {
      base.memTotal = Math.round(total / 1048576)
      if (available > 0) base.memFree = Math.round((available * page) / 1048576)
    }
    results['apple-silicon'] = 'yes'
    results['apple-silicon-model'] = base.model
  } else if (process.platform === 'linux') {
    const out = await runShell(
      "grep MemTotal /proc/meminfo; grep MemAvailable /proc/meminfo;"
      + " for d in /sys/class/drm/card*/device; do"
      + ' [ -r "$d/vendor" ] && echo "gpu-vendor: $(cat "$d/vendor") $(cat "$d/device" 2>/dev/null)";'
      + ' [ -r "$d/mem_info_vram_total" ] && echo "gpu-vram: $(cat "$d/mem_info_vram_total")";'
      + ' done 2>/dev/null',
      options.timeoutMs,
    )
    for (const line of String(out).split(/\r?\n/)) {
      const mem = /^(MemTotal|MemAvailable):\s+(\d+) kB/.exec(line)
      if (mem) {
        const mib = Math.round(Number(mem[2]) / 1024)
        if (mem[1] === 'MemTotal') base.memTotal = mib
        else base.memFree = mib
      }
      const vendor = /^gpu-vendor:\s+(\S+)\s*(\S*)/.exec(line)
      if (vendor) {
        const id = `${vendor[1]} ${vendor[2]}`.toLowerCase()
        // 8086 = Intel, 1002 = AMD: both ship integrated GPUs over system RAM.
        if (id.startsWith('0x8086') || id.startsWith('0x1002')) results['integrated-gpu'] = 'yes'
      }
      const vram = /^gpu-vram:\s+(\d+)/.exec(line)
      if (vram) results['gpu-vram'] = String(Math.round(Number(vram[1]) / 1048576))
    }
  }

  // Is there a GPU at all? (An NVIDIA driver answers even when nvidia-smi is absent.)
  const nvidia = await runShell(
    'command -v nvidia-smi >/dev/null 2>&1 && echo nvidia'
    + '; [ -e /dev/nvidia0 ] && echo nvidia'
    + '; [ -d /dev/dri ] && echo dri',
    Math.min(options.timeoutMs, 3000),
  )
  if (/nvidia/.test(nvidia)) results['discrete-gpu'] = 'yes'
  if (/dri/.test(nvidia)) results['render-node'] = 'yes'

  // Apple's unified memory is the "VRAM" a job can use; elsewhere the share a
  // driver reports (or nothing) is the honest answer.
  let kind = 'none'
  let total = null
  let free = null
  if (results['apple-silicon'] === 'yes') {
    kind = 'unified'
    total = base.memTotal
    free = base.memFree
  } else if (results['gpu-vram']) {
    kind = 'shared'
    total = Number(results['gpu-vram'])
    free = null
  } else if (results['integrated-gpu'] === 'yes') {
    kind = 'integrated'
  }

  const detail = kind === 'none'
    ? (results['discrete-gpu'] === 'yes' || results['render-node'] === 'yes'
      ? 'This machine has a GPU, but its driver reports no memory the CPU can read.'
      : 'This machine has no usable GPU.')
    : null

  const cpu = {
    model: base.model,
    cores: base.cores,
    memTotal: total ?? base.memTotal,
    memFree: free ?? base.memFree,
    memoryKind: kind,
    detail,
  }

  // No process sampling on purpose: a CPU view answers "can this machine hand
  // memory to a job", and a per-process list costs a `ps` scan per poll while
  // telling nobody who owns the GPU time.
  const gpus = []
  if (kind === 'unified') {
    const model = results['apple-silicon-model'] || base.model
    gpus.push({
      index: 0,
      name: `${model} (unified · MPS/Metal)`,
      utilization: null,
      memoryUsed: total === null ? null : Math.max(0, total - base.memFree),
      memoryTotal: total,
      temperature: null,
      processes: [],
    })
  }
  return { cpu, gpus }
}

/**
 * Render a CPU result as the probe's `==DSHGPU cpu==` section, so a local
 * snapshot and a remote one go through the same parser.
 * @param {{cpu: object, gpus: object[]}} result - from {@link probeCpu}.
 * @returns {string} marker-delimited lines.
 */
export function cpuSection(result) {
  const { cpu, gpus } = result
  const lines = ['==DSHGPU cpu==', `kind: ${cpu.memoryKind}`]
  if (cpu.detail) lines.push(`detail: ${cpu.detail}`)
  lines.push(`mem: ${cpu.memFree} ${cpu.memTotal}`)
  if (gpus.length > 0) {
    const gpu = gpus[0]
    lines.push(`gpu: 0,${gpu.name.replace(/,/g, ' ')},${gpu.memoryUsed},${gpu.memoryTotal}`)
  }
  return lines.join('\n')
}

/**
 * Parse the `==DSHGPU cpu==` section back into the wire shape.
 * @param {string[]} lines - section lines.
 * @returns {{cpu: object, gpus: object[]}|null} null when the section is absent.
 */
export function parseCpuSection(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null
  const pairs = parsePairs(lines.join('\n'))
  if (!pairs.kind) return null
  const [free, total] = String(pairs.mem || '').split(/\s+/).map(Number)
  const cpu = {
    model: '',
    cores: 0,
    memTotal: Number.isFinite(total) ? total : null,
    memFree: Number.isFinite(free) ? free : null,
    memoryKind: pairs.kind,
    detail: pairs.detail || null,
  }
  const gpus = []
  const gpu = pairs.gpu ? pairs.gpu.split(',') : null
  if (gpu && gpu.length >= 4) {
    const used = Number(gpu[2])
    const memTotal = Number(gpu[3])
    gpus.push({
      index: 0,
      name: gpu[1] || 'unified memory',
      utilization: null,
      memoryUsed: Number.isFinite(used) ? used : null,
      memoryTotal: Number.isFinite(memTotal) ? memTotal : null,
      temperature: null,
      processes: [],
    })
  }
  return { cpu, gpus }
}

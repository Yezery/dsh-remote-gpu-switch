// dsh-remote-gpu-switch — which machine does the current workspace belong to?
//
// dsh-remote already records that binding durably: a remote workspace is a
// local mirror directory under `$DSH_HOME/remote-workspaces/<host-dir>/<name>/`
// carrying a `.dsh-remote-meta.json` with its origin. `lib/binding.js` in
// dsh-remote reads exactly that file, and every rw_* tool resolves the host
// from it, so reading the same record here cannot disagree with what rw_exec
// will actually run against.
//
// A workspace outside that tree is local: the GPU view then probes this host.
// Pure filesystem helpers, so the classification is unit-testable.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const norm = (value) => path.resolve(String(value || '')).replace(/[\\/]+$/, '')

/** The OS-resolved spelling when it exists, else the lexical one. */
const tryReal = (value) => {
  try { return norm(realpathSync(value)) } catch { return norm(value) }
}

/**
 * The directory dsh-remote keeps its workspace mirrors in.
 * Mirrors dsh-remote's own `dshBase()` rule (DSH_HOME or ~/.dsh).
 * @param {Record<string, string|undefined>} [env] - environment to read.
 * @returns {string} absolute mirror root.
 */
export function remoteWorkspacesRoot(env = process.env) {
  const configured = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const home = configured ? path.resolve(configured) : path.join(os.homedir(), '.dsh')
  return path.join(home, 'remote-workspaces')
}

/**
 * Whether `child` is `parent` itself or nested under it, separator-aware.
 * @param {string} child - absolute path.
 * @param {string} parent - absolute path.
 * @returns {boolean} true when contained.
 */
export function isInsidePath(child, parent) {
  const c = norm(child)
  const p = norm(parent)
  if (!p) return false
  if (process.platform === 'win32') {
    const lc = c.toLowerCase()
    const lp = p.toLowerCase()
    return lc === lp || lc.startsWith(lp.endsWith('\\') ? lp : `${lp}\\`)
  }
  return c === p || c.startsWith(`${p}/`)
}

/**
 * Resolve the remote origin of a local workspace path by walking up from it
 * until a dsh-remote mirror meta file is found (the mirror root itself is one
 * level deeper than the host directory, but walking tolerates any nesting).
 *
 * @param {string} cwd - absolute workspace path (a session cwd).
 * @param {string} [root] - mirror root; defaults to {@link remoteWorkspacesRoot}.
 * @returns {{dir: string, host: string, port: number, username: string,
 *   alias: string, remotePath: string}|null} the mirror origin, or null for a
 *   local workspace / an unusable mirror record.
 */
export function findMirrorForCwd(cwd, root = remoteWorkspacesRoot()) {
  const base = norm(cwd)
  const mirrorRoot = norm(root)
  if (!base || !mirrorRoot || base === mirrorRoot || !isInsidePath(base, mirrorRoot)) {
    // A session cwd spelled through a symlink (or a symlinked DSH_HOME) is not
    // lexically inside the mirror root. dsh-remote resolves real paths for the
    // same reason; mirror that so classification cannot disagree with rw_exec.
    const realBase = tryReal(cwd)
    const realRoot = tryReal(root)
    if (realBase === realRoot || !isInsidePath(realBase, realRoot)) return null
    return walkForMeta(realBase, realRoot)
  }
  return walkForMeta(base, mirrorRoot)
}

/**
 * Walk up from a contained path until a mirror meta file appears.
 * @param {string} base - absolute path known to be inside `root`.
 * @param {string} root - absolute mirror root.
 * @returns {object|null} the mirror origin.
 */
function walkForMeta(base, root) {
  let dir = base
  while (dir !== root && isInsidePath(dir, root)) {
    const metaPath = path.join(dir, '.dsh-remote-meta.json')
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
        if (meta && meta.host) {
          return {
            dir,
            host: String(meta.host),
            port: Number(meta.port) || 22,
            username: String(meta.username || ''),
            alias: String(meta.alias || ''),
            remotePath: String(meta.remotePath || ''),
          }
        }
      } catch {
        /* unparsable meta → treat as local, same as dsh-remote's binding.js */
      }
      return null
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Stable machine identity for one mirror, matching dsh-remote's pool key.
 * @param {{username?: string, host: string, port?: number}} mirror - origin.
 * @returns {string} `user@host:port`.
 */
export function machineKey(mirror) {
  return `${mirror.username || ''}@${mirror.host}:${Number(mirror.port) || 22}`
}

/**
 * The per-machine cache key for a remote workspace.
 * @param {object} mirror - origin from {@link findMirrorForCwd}.
 * @returns {string} target key.
 */
export function targetKeyForMirror(mirror) {
  return `remote:${machineKey(mirror)}`
}

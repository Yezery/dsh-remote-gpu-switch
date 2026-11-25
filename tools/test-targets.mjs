// Workspace → host classification check. Run with:
//   node tools/test-targets.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findMirrorForCwd,
  isInsidePath,
  machineKey,
  remoteWorkspacesRoot,
  targetKeyForMirror,
} from '../lib/workspace-target.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-gpu-targets-'))
try {
  const root = path.join(home, 'remote-workspaces')
  const mirror = path.join(root, 'gpu-lab-alice-2222', 'proj')
  mkdirSync(path.join(mirror, 'src'), { recursive: true })
  writeFileSync(path.join(mirror, '.dsh-remote-meta.json'), JSON.stringify({
    host: '10.0.0.5',
    port: 2222,
    username: 'alice',
    remotePath: '/home/alice/proj',
  }))

  process.env.DSH_HOME = home
  assert.equal(remoteWorkspacesRoot(), root)

  const found = findMirrorForCwd(mirror, root)
  assert.equal(found?.host, '10.0.0.5')
  assert.equal(found?.remotePath, '/home/alice/proj')
  assert.equal(machineKey(found), 'alice@10.0.0.5:2222')
  assert.equal(targetKeyForMirror(found), 'remote:alice@10.0.0.5:2222')

  // A cwd nested deeper still resolves the same workspace host.
  assert.equal(findMirrorForCwd(path.join(mirror, 'src'), root)?.host, '10.0.0.5')

  // A workspace reached through a symlink still resolves (realpath fallback).
  if (process.platform !== 'win32') {
    const link = path.join(home, 'mirror-link')
    symlinkSync(mirror, link, 'dir')
    assert.equal(findMirrorForCwd(link, root)?.host, '10.0.0.5')
  }

  // Local directories are not mirrors.
  assert.equal(findMirrorForCwd(path.join(home, 'local-project'), root), null)
  assert.equal(findMirrorForCwd(root, root), null)

  // Containment is separator-aware: /mirror-2 is not inside /mirror.
  assert.equal(isInsidePath('/a/mirror-2', '/a/mirror'), false)
  assert.equal(isInsidePath('/a/mirror/x', '/a/mirror'), true)

  console.log('ALL PASS findMirrorForCwd / machineKey')
} finally {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
}

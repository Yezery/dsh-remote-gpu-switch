# dsh-remote-gpu-switch

A DSH plugin that shows **live GPU utilization of the machine the current workspace belongs to**.

Open a **local** workspace and it probes this computer; open a **remote** workspace and it
probes the SSH host that workspace is bound to, through dsh-remote. Switch workspaces and the
GPU view switches hosts with it.

Remote probing piggybacks on `dsh-remote`: the host half calls dsh-remote's own `rw_exec` tool
as the session's agent, so no second SSH connection, no duplicated credential handling, and no
extra dependency. The workspace's `.dsh-remote-meta.json` is what dsh-remote itself uses, so the
GPU view always lands on the same host as the session's `rw_*` tools.

## What you get

| Seat | What it shows |
| --- | --- |
| Conversation header chip | `空闲 {idle}/{total}` for the current workspace's host (green = all free, amber = some free, red = none). Local workspace without a GPU shows `无 GPU` in muted grey. The tooltip names the machine and the users currently on it. Click to open the panel. |
| Right sidebar tab `显卡` | Every GPU of that host in detail: name, utilization %, memory used/total, temperature, **the user who owns the task running on it** (`占用 <user>×<n>`), an `空闲` tag on free cards, the machine identity (local hostname / remote alias + address) and a sparkline of recent samples. |
| Settings → `显卡` | Probe status, workspace kind, machine, probed hostname, backend, idle count, refresh interval, the exact probe command, a "refresh now" button, the per-GPU process list and an "active users" summary. |
| Host tool `remote_gpu` | The same snapshot as text for the agent, resolved from the calling session's own workspace. |

## Local and remote are one entry point

The split happens once, by the session's workspace directory:

- **Local workspace** — the session cwd is a normal directory. The host runs the probe script
  on this machine and parses the same output. If no GPU backend exists, the status stays `ok`
  with an explicit **「本机没有可用 GPU」** message: no error card, no empty panel.
- **Remote workspace** — the session cwd sits inside a dsh-remote mirror
  (`$DSH_HOME/remote-workspaces/...`, the directory carrying `.dsh-remote-meta.json`). The
  probe still goes through `rw_exec`, now bound to *that workspace's* host and agent, so several
  remote hosts can be watched by simply switching workspaces. The remote display path is
  unchanged, and the probe runs under the same session sandbox policy as the session's own
  `rw_*` tools (a read-only remote session refuses the exec).
- **No session context** — the `remote_gpu` tool outside a session, or the settings page before
  any workspace was viewed, keeps the original behaviour and targets the active dsh-remote
  machine.

The host keeps one sample per machine (`local`, or `remote:user@host:port`), so two workspaces on
the same host share one reading while workspaces on different hosts stay independent. Host is the
switchable dimension; GPUs are the devices inside one host and are never mixed across machines.

## What counts as a free GPU

A card is *idle* when it is barely drawing power **and** barely holding memory:

- utilization `< idleUtilPercent` (default **10 %**), and
- memory used `< idleMemoryPercent` (default **5 %**) of the card.

Both must hold: a model that is loaded but idle still owns its VRAM, so that
card is not free for a new job. The host computes the verdict and ships it
with every sample, so the chip, the panel and the `remote_gpu` tool always
agree on the same number.

```
Local host <hostname> — <backend>
Remote host <user>@<host>:<port> — <backend>
Idle GPUs: <idle>/<total> (util < 10%, memory < 5%)
GPU <index> <name> · util <n>% · memory <used>/<total> MiB · temp <n>°C · idle
GPU <index> <name> · util <n>% · memory <used>/<total> MiB · temp <n>°C · users <user>×<n>
```

## Who is using each GPU

Every GPU card names the owner of the task that runs on it:

```
GPU <index> · <name>
<util>%   <used>/<total>   <mem%>   <temp> °C   占用 <user>×<n>
```

The panel header adds the overall count (`<total> 张显卡 · 空闲 <idle> 张 · <users> 个用户`),
and the chip tooltip summarises the same thing. On NVIDIA hosts the probe adds
three extra sections to the command:

```sh
nvidia-smi --query-gpu=index,uuid --format=csv,noheader,nounits   # ==DSHGPU uuid==
nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory …        # ==DSHGPU procs==
ps -o pid=,user=,comm= -p <pids>                                  # ==DSHGPU ps==
```

`lib/gpu-parse.js` maps the GPU UUIDs to indices and the PIDs to their owner
(`user` + command), so each GPU ends up with `processes[]` and a per-GPU
`users[]` summary. On ROCm / gpustat hosts the process list stays empty —
those tools do not expose per-process GPU ownership.

## Motion

Every reading eases into place instead of snapping:

- one shared `requestAnimationFrame` loop drives all tweens, so a panel with
  many GPUs still costs a single frame callback;
- utilization, memory and temperature glide to their new value over ~520 ms
  (`TWEEN_MS` in `client.js`);
- the utilization and memory bars, the sparkline line and the chip dot morph
  continuously — the sparkline even slides one sample to the left;
- the panel header carries a slow breathing dot, a GPU card fades in when it
  appears, and the loading state uses a shimmer instead of static text;
- `prefers-reduced-motion: reduce` switches every animation off.

## How the probe works

On a **remote** host it runs one POSIX shell line through `rw_exec`; on a
**local** host the same line runs through `sh -c`. It picks the first available
backend and wraps every part in `==DSHGPU …==` markers:

| Section | Content |
| --- | --- |
| `host` | `hostname` of the probed machine |
| `backend` | `nvidia-smi`, `rocm-smi`, `gpustat` or `none` |
| `gpus` | one CSV row per GPU (`index,name,utilization.gpu,memory.used,memory.total`) |
| `temp` | GPU temperature (NVIDIA only) |
| `uuid` | GPU index → UUID (NVIDIA only, links processes to GPUs) |
| `procs` | running compute apps: `pid,gpu_uuid,used_memory` (NVIDIA only) |
| `ps` | owner of each PID: `pid,user,command` (NVIDIA only) |

`lib/gpu-parse.js` parses those sections into the snapshot the UI renders, and
`lib/workspace-target.js` maps a session cwd to its remote origin.

Requirements: `nvidia-smi` (or `rocm-smi` / `gpustat`) on `PATH` — remotely for
a remote workspace, locally for a local one. Remote workspaces need a
dsh-remote **active remote workspace** session. Local probing uses `sh`, so on
Windows it needs Git Bash's `sh` on `PATH`; without it the panel reports a local
probe error instead of a false "no GPU".

## Configuration

`cordis.patch.yml` carries the tunables:

```yaml
- insert:
    - id: dsh-remote-gpu-switch
      name: dsh-remote-gpu-switch
      config:
        intervalMs: 3000        # refresh cadence (500 – 300000)
        commandTimeoutMs: 15000 # probe timeout (local or remote)
        idleStopMs: 120000      # stop probing a machine after no panel asked for it
        historyLength: 90       # samples kept for the sparkline
        idleUtilPercent: 10     # a card is free below this utilization …
        idleMemoryPercent: 5    # … and below this memory usage
        # command: '…'          # override the REMOTE probe command entirely
        # localCommand: '…'     # override the LOCAL probe command
```

## Install

```bash
plugin_manager install_bundle target=<abs path to this directory>
plugin_manager set_bundle target=dsh-remote-gpu-switch enabled=true
```

`install_bundle` only runs pnpm; the second command is what puts the plugin's row
into the profile's bundle layer (`dsh.profile.bundles` in the profile
`package.json`). Without it the plugin works until the next DSH restart and then
silently disappears — the symptom is a vanished chip and a "removed tool" notice
in the session.

The plugin is offline-safe: it has **zero runtime dependencies** and imports nothing
from `@deepseek-ai/*`.

## Checks

```bash
npm test   # all four checks below
node tools/test-parse.mjs      # probe parser
node tools/test-targets.mjs    # local vs remote workspace classification
node tools/test-host.mjs       # local / remote / settings routing
sh tools/check-command.sh      # probe command survives sh and bash
```

## Changelog

### 1.2.1

- Remote probing calls `rw_exec`'s body directly instead of routing a batch through
  `ctx.tools.execute`. The gate-way path ran the tool outside the session log, which made
  the auto-review preset refuse every probe ("the pending root call is missing or ambiguous
  in the session log"); it also looked the tool up by agent id instead of the agent's scope.
- A session with no workspace yet now reports "no workspace" instead of a probe error.

### 1.2.0

- The GPU view follows the **workspace**, not one global machine: local workspaces probe
  this host, remote workspaces probe their own dsh-remote host.
- One cached sample per machine (`local` / `remote:user@host:port`), so switching
  workspaces switches hosts without one workspace blanking another.
- Local probing without any GPU backend reports **no GPU** explicitly instead of an error.
- Remote probing now runs `rw_exec` as the calling session's agent, so dsh-remote resolves
  the workspace's mirror-bound host (no active-machine fallback, same sandbox policy).
- Renamed the plugin to `dsh-remote-gpu-switch`.

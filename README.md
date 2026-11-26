# dsh-remote-gpu-switch

A DSH plugin that answers one question for the workspace you are working in:
**is the GPU of this machine free, how busy is it, and who is using it?**

Open a **local** workspace and it reads this computer. Open a **remote** workspace and it
reads the SSH host that workspace is bound to, through dsh-remote. Switch workspaces and the
GPU view switches hosts with it — host is the switchable dimension, GPUs are the devices inside
one host, and the two are never mixed.

Remote probing piggybacks on `dsh-remote`: the host half calls dsh-remote's own `rw_exec` tool
as the calling session's agent, so there is no second SSH connection, no separate credential
handling and no extra dependency. The workspace's `.dsh-remote-meta.json` — the same record
dsh-remote routes its own `rw_*` tools with — decides which host is read, so the GPU view always
lands on the machine the session is actually working on.

## What you get

| Seat | What it shows |
| --- | --- |
| Conversation header chip | `空闲 {idle}/{total}` for the current workspace's host (green = all free, amber = some free, red = none). Muted `无 GPU` when the machine has none, `GPU ⏸` when auto sampling is off. The tooltip names the machine and the users on it. Click to open the panel. |
| Right sidebar tab `显卡` | Every GPU of that host: name, utilization %, memory used/total, temperature, **the user who owns the task running on it** (`占用 <user>×<n>`), an `空闲` tag on free cards, the machine identity (local hostname / remote alias + address), a **refresh** button and a sparkline of recent samples. |
| Settings → `显卡面板` | Auto sampling and CPU switches at the top, then probe status, workspace kind, machine, probed hostname, backend, idle count, interval, the exact probe command, a "refresh now" button, the per-GPU process list and the active-user summary. The nav row carries the plugin's own mark. |
| Host tool `remote_gpu` | The same snapshot as text for the agent, resolved from the calling session's own workspace. |

## Local and remote share one entry point

The split happens once, by the session's workspace directory:

- **Local workspace** — the session cwd is an ordinary directory. The host runs the probe
  script on this machine and parses the same output. A machine without a GPU backend stays
  `ok` with an explicit **「本机没有可用 GPU」**: no error card, no empty panel.
- **Remote workspace** — the session cwd sits inside a dsh-remote mirror
  (`$DSH_HOME/remote-workspaces/...`, the directory carrying `.dsh-remote-meta.json`). The probe
  still goes through `rw_exec`, bound to *that workspace's* host and agent, so several remote
  hosts can be watched by switching workspaces. The remote display path is unchanged, and the
  probe runs under the same session sandbox policy as the session's own `rw_*` tools (a
  read-only remote session refuses the exec).
- **No session context** — the `remote_gpu` tool outside a session, or the settings page before
  any workspace was viewed, keeps the original behaviour and targets the active dsh-remote
  machine.

The host keeps one sample per machine (`local`, or `remote:user@host:port`), so two workspaces
on the same host share one reading while workspaces on different hosts stay independent.

## What counts as a free GPU

A card is *idle* when it is barely drawing power **and** barely holding memory:

- utilization `< idleUtilPercent` (default **10 %**), and
- memory used `< idleMemoryPercent` (default **5 %**) of the card.

Both must hold: a model that is loaded but idle still owns its VRAM, so that card is not free
for a new job. The host computes the verdict and ships it with every sample, so the chip, the
panel and the `remote_gpu` tool always agree on the same number.

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
and the chip tooltip summarises the same thing. On NVIDIA hosts the probe adds three extra
sections to the command:

```sh
nvidia-smi --query-gpu=index,uuid --format=csv,noheader,nounits   # ==DSHGPU uuid==
nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory …        # ==DSHGPU procs==
ps -o pid=,user=,comm= -p <pids>                                  # ==DSHGPU ps==
```

`lib/gpu-parse.js` maps GPU UUIDs to indices and PIDs to their owner (`user` + command), so each
GPU ends up with `processes[]` and a per-GPU `users[]` summary. ROCm and gpustat hosts report no
per-process ownership, so their cards carry no user line.

## Machines without nvidia-smi

| Machine | What the panel shows |
| --- | --- |
| NVIDIA | `nvidia-smi` rows, temperature and per-process owners |
| AMD | `rocm-smi` (utilization, VRAM, temperature) |
| any with gpustat | `gpustat --json` |
| Apple Silicon | the `apple-silicon` backend; the **CPU / unified memory** view supplies the unified-memory device (Metal/MPS) |
| no GPU | an explicit "no GPU" — local and remote alike |

The CPU fallback is a toggle in the settings page, **off by default**, so a GPU machine pays
nothing for it. When on and there is no GPU card it reads the CPU and answers in memory terms:
unified memory (Apple), shared VRAM (integrated GPU, when the driver reports it), an integrated
GPU whose driver reports no VRAM, or no usable GPU. It reads memory and cores only — it does not
sample processes, so there is no per-user or per-process list for a CPU.

## Cost and controls

The view is a status indicator, so it stays cheap and says when it is stale:

| Control | Effect |
| --- | --- |
| Auto sampling (settings, on) | Off stops the cadence entirely — nothing probes on a timer. Asking by hand still works: the panel's refresh button (and the agent tool) take one reading. |
| Panel closed / browser tab hidden | Polling pauses; a returning surface re-reads only when its cached sample is older than 20 s. |
| `idleStopMs` (default 30 s) | A machine stops being probed this long after the last client asked for it. |
| `intervalMs` (default 15 s) | Cadence while something is watching. |

One local probe is a single `sh` call (roughly 10–20 ms); one remote probe is one `rw_exec`
over dsh-remote's existing connection.

## Motion

Every reading eases into place instead of snapping: one shared `requestAnimationFrame` loop
drives all tweens (utilization, memory, temperature glide over ~520 ms), the bars, the sparkline
and the chip dot morph continuously, `prefers-reduced-motion: reduce` switches every animation
off, and a probe in flight shows a spinner rather than a red failure card.

## How the probe works

On a **remote** host one POSIX shell line runs through `rw_exec`; on a **local** host the same
line runs through `sh -c`. It picks the first available backend and wraps each part in
`==DSHGPU …==` markers:

| Section | Content |
| --- | --- |
| `host` | `hostname` of the probed machine |
| `backend` | `nvidia-smi`, `rocm-smi`, `gpustat`, `apple-silicon` or `none` |
| `gpus` | one CSV row per GPU (`index,name,utilization.gpu,memory.used,memory.total`) |
| `temp` | GPU temperature (NVIDIA only) |
| `uuid` | GPU index → UUID (NVIDIA only, links processes to GPUs) |
| `procs` | running compute apps: `pid,gpu_uuid,used_memory` (NVIDIA only) |
| `ps` | owner of each PID: `pid,user,command` (NVIDIA only) |

`lib/gpu-parse.js` parses those sections into the snapshot the UI renders,
`lib/workspace-target.js` maps a session cwd to its remote origin, and `lib/cpu-probe.js`
supplies the optional CPU / unified-memory reading.

Requirements: `nvidia-smi` (or `rocm-smi` / `gpustat`) on `PATH` — remotely for a remote
workspace, locally for a local one. Remote workspaces need a dsh-remote active remote workspace
session. Local probing uses `sh`, so Windows needs Git Bash's `sh` on `PATH`; without it the
panel reports a local probe error instead of a false "no GPU".

## Configuration

`cordis.patch.yml` carries the tunables:

```yaml
- insert:
    - id: dsh-remote-gpu-switch
      name: dsh-remote-gpu-switch
      config:
        intervalMs: 15000       # refresh cadence (500 – 300000)
        commandTimeoutMs: 15000 # probe timeout (local or remote)
        idleStopMs: 30000       # stop probing a machine after no panel asked for it
        historyLength: 20       # samples kept for the sparkline
        idleUtilPercent: 10     # a card is free below this utilization …
        idleMemoryPercent: 5    # … and below this memory usage
        showCpu: false          # CPU fallback default (the settings page has the switch)
        # command: '…'          # override the REMOTE probe command entirely
        # localCommand: '…'     # override the LOCAL probe command
```

## Install

```bash
plugin_manager install_bundle target=<abs path to this directory>
plugin_manager set_bundle target=dsh-remote-gpu-switch enabled=true
```

`install_bundle` only runs pnpm; the second command is what puts the plugin's row into the
profile's bundle layer (`dsh.profile.bundles` in the profile `package.json`). Without it the
plugin works until the next DSH restart and then silently disappears — the symptom is a vanished
chip and a "removed tool" notice in the session.

The plugin is offline-safe: **zero runtime dependencies**, and it imports nothing from
`@deepseek-ai/*`.

## Checks

```bash
npm test   # all four checks below
node tools/test-parse.mjs      # probe parser (NVIDIA, ROCm, gpustat, Apple, broken)
node tools/test-targets.mjs    # local vs remote workspace classification
node tools/test-host.mjs       # local / remote / settings / auto-sampling routing
sh tools/check-command.sh      # the probe command survives sh and bash
```

## Changelog

### 1.4.0

- Documentation pass: the README now describes what the plugin does today (workspace-following
  host, Apple Silicon, CPU fallback, auto sampling, cost controls) with a full changelog;
  the package and locale descriptions say the same thing in one line for the market card.

### 1.3.9

- The switch is **自动采集 / Auto sampling**, and it pauses the cadence only: with it off
  nothing probes on a timer, while the side panel's refresh button (and the agent tool)
  still take one reading by hand. The chip turns muted (`GPU ⏸`) so a held sample is
  never mistaken for a live one.

### 1.3.8

- Settings → 显卡面板 puts the switches **at the top**, drawn as switches (native checkbox
  underneath, so keyboard and screen readers keep working) instead of checkboxes.

### 1.3.7

- Settings → **显卡面板** gains an **自动采集 / Auto sampling** switch (originally a
  "sampling master switch"). Stored in the browser like the CPU switch.

### 1.3.5

- **Lighter by default**: cadence 3 s → 8 s → **15 s**, idle stop 2 min → 1 min → **30 s**,
  sparkline 90 → 20 samples. Polling pauses while the browser tab is hidden and the pane is
  closed, and a returning surface re-reads only when its cached sample is older than 20 s.

### 1.3.4

- A Mac no longer reports a unified-memory GPU with the CPU view **off**: the Darwin branch of
  the shell only names the backend, so no device, no process list and no "active users" appear
  unless the CPU view supplied it.

### 1.3.3

- The settings navigation row shows the plugin's own mark: the icon registers through
  `settings.section.icon` (addressed by the section id), which is what replaces the shell's
  default glyph.

### 1.3.2

- The CPU view no longer repeats an integrated GPU as a GPU card with a user/process list.

### 1.3.1

- The CPU fallback reads memory and cores only; it no longer samples processes.

### 1.3.0

- The GPU view follows the **workspace**, not one global machine: local workspaces probe this
  host, remote workspaces probe their own dsh-remote host.
- One cached sample per machine (`local` / `remote:user@host:port`).
- Local probing without any GPU backend reports **no GPU** explicitly instead of an error.
- Remote probing runs `rw_exec` as the calling session's agent, so dsh-remote resolves the
  workspace's mirror-bound host (no active-machine fallback, same sandbox policy).
- Renamed the plugin to `dsh-remote-gpu-switch`.

### 1.2.3

- Refresh button in the GPU panel header.

### 1.2.2

- A loading spinner instead of a failure card while a workspace's GPU is probed; the poller
  retries with a bounded back-off.

### 1.2.1

- Remote probing calls `rw_exec`'s body directly instead of routing a batch through
  `ctx.tools.execute`, which ran outside the session log the auto-review preset reads.

### 1.2.0

- The first workspace-aware release (see 1.3.0, where it became the plugin's identity).

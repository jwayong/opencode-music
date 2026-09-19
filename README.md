# opencode-music

An [opencode](https://opencode.ai) plugin that plays an **Apple Music** playlist while
opencode is working ("thinking") and pauses it when it goes idle. Built for macOS.

> ⚠️ **Experimental.** This project is early, best-effort software — expect rough edges,
> breaking changes, and no stability guarantees. It drives AppleScript/`osascript` on your
> machine and may misbehave (e.g. timing quirks). Use at your own risk; contributions and
> bug reports welcome.
>
> More is coming: support for **other coding agents** beyond opencode — including
> [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and
> [pi.dev](https://pi.dev) — is planned. See [Roadmap](#roadmap).

## What it does

- When opencode starts a turn (`session.status` → `busy`), it starts or resumes the
  configured Apple Music playlist.
- When opencode finishes and goes idle (`session.status` → `idle` / `session.idle`),
  it **pauses** playback.
- When opencode **prompts you for input** (a permission request or a question), it pauses
  too, and resumes once you answer — so music never plays over a prompt.
- **Resume, not restart:** the playlist is loaded once; later turns resume the paused
  track at its saved position instead of restarting from the top.
- **Fade in / out at your volume:** starting playback fades the track in and pausing fades it
  out. The base level is always your current Music volume — read at fade time and restored
  after a fade-out, so you're never left muted or forced to a fixed level.
- **Won't hijack your listening:** it only pauses music that *it* started. If you were
  already playing something when opencode began, it leaves it alone.

## How it works

A plugin's `event({ event })` hook receives every bus event opencode emits. The relevant
signals per session are:

| Event | Meaning | Action |
| --- | --- | --- |
| `session.status` → `status.type === "busy"` | a turn started (working/thinking) | fade in / seed playlist |
| `session.status` → `status.type === "idle"` | the turn finished | fade out & pause |
| `session.idle` | session idle (belt-and-suspenders) | fade out & pause |
| `permission.asked` / `question.asked` | opencode is waiting on you | fade out & pause |
| `permission.replied` / `question.replied` / `question.rejected` | you answered / dismissed | fade in (once no prompts remain) |

Playback is driven through macOS **AppleScript** (`osascript`) via the Bun `$` shell the
plugin receives. Fades ramp `sound volume` between silence and your current level: it reads
your existing volume as the base, so it fades toward *your* setting and restores it after a
fade-out rather than dictating a fixed level.

## Files

| Path | Purpose |
| --- | --- |
| `~/.config/opencode/plugin/apple-music.ts` | The plugin (global scope). |
| `~/.config/opencode/command/music.md` | `/music` slash command to toggle at runtime. |
| `~/.config/opencode/.apple-music.json` | Runtime on/off state (`{ "enabled": true }`). Absent = enabled. |
| `~/.config/opencode/opencode.json` | Registers the plugin via `"plugin": ["./plugin/apple-music.ts"]`. |

### Registration (`opencode.json`)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./plugin/apple-music.ts"],
  "...": "your existing model/provider config is preserved"
}
```

## Install / enable

1. Place `apple-music.ts` in `~/.config/opencode/plugin/`.
2. Add `"plugin": ["./plugin/apple-music.ts"]` to `~/.config/opencode/opencode.json`
   (keep all your other fields).
3. **Quit and restart opencode** — config is loaded once and not hot-reloaded.
4. On the first working turn, approve the macOS prompt that lets it control **Music**
   (System Settings → Privacy & Security → Automation).

## Configuration

All settings are constants at the top of `apple-music.ts`. Edit them, reinstall
(`npm run install-plugin`), and restart opencode.

```ts
const PLAYLIST = "Trance Coding" // exact Apple Music playlist name to play
```

| Constant | Default | Description |
| --- | --- | --- |
| `PLAYLIST` | `"Trance Coding"` | Exact Apple Music playlist name to play. |
| `FADE_MS` | `1500` | Fade duration in ms (env `APPLE_MUSIC_FADE_MS`). |
| `STEP` | `10` | Volume step per tick, 0–100 (env `APPLE_MUSIC_FADE_STEP`). |

Tune fades without editing code via env vars, e.g. `APPLE_MUSIC_FADE_MS=2500 opencode`.

### Playlist

`PLAYLIST` must **exactly** match a playlist name in your Music library (case-sensitive).
List yours with:

```bash
osascript -e 'tell application "Music" to get name of every playlist'
```

Notes:

- The playlist is *seeded* on the first working turn (`play playlist "<name>"`) and then
  resumed, so it does not restart from track 1 every turn.
- If you change `PLAYLIST`, it re-seeds on the next new session's first turn.
- Use a real user playlist (e.g. `"Office DJ"`), not the smart "Library"/"Music" roots —
  those may not start playback as expected.

Examples:

```ts
const PLAYLIST = "Office DJ"            // calm focus playlist
const PLAYLIST = "Taylor Swift Essentials"
```

### Scope: global vs per-project

The plugin is registered from an `opencode.json` under the path `plugin/apple-music.ts`,
so put both the file and the registration where you want it active:

| Scope | Plugin file location | Register in |
| --- | --- | --- |
| Global (all projects) | `~/.config/opencode/plugin/apple-music.ts` | `~/.config/opencode/opencode.json` |
| Single project | `<project>/.opencode/plugin/apple-music.ts` | `<project>/opencode.json` |

Global example (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./plugin/apple-music.ts"]
}
```

Per-project example (`<project>/opencode.json`) — same `"plugin"` entry; the path resolves
relative to that config, so the file lives in `<project>/.opencode/plugin/`. This lets you
run different playlists (or disable it) per project.

### Enable / disable state

The on/off toggle is stored separately from code in `~/.config/opencode/.apple-music.json`
(`{ "enabled": true }`). Missing file = enabled. See [Enable / disable at
runtime](#enable--disable-at-runtime-no-restart).

## Enable / disable at runtime (no restart)

Toggle playback from inside opencode without editing config. The plugin exposes an
`apple_music` tool and a `/music` slash command:

```
/music on       # start playing on the next working turn
/music off      # pause now and skip future turns
/music toggle   # flip the current state
/music status   # report whether it is enabled
```

- State persists in `~/.config/opencode/.apple-music.json`; if the file is missing the
  plugin defaults to **enabled**.
- Turning it off pauses immediately if music was playing; turning it on takes effect on
  the next turn.
- You can also ask opencode directly, e.g. *"disable the background music"* — it calls the
  same tool.

## Behavior notes & gotchas

- **Playlist name must match exactly.** List yours with:
  `osascript -e 'tell application "Music" to get name of every playlist'`
- **Fades use your volume as the base:** start fades in from silence and pause fades out, then
  restores your original `sound volume` so you're never left muted. An earlier version ramped
  volume unsafely (concurrent fades read a mid-ramp value and could mute you); that can't
  happen now because every play/pause runs through one serialized worker.
- **Resume caveat:** plain `play` resumes whatever track Music last had loaded. The first
  turn of a session always seeds the playlist, so this only matters if you manually clear
  the queue mid-session.
- **Already playing?** If Music is playing when opencode starts working, it won't switch
  playlists or pause your audio — it only manages playback it initiated.
- **Prompts:** music pauses on `permission.asked` / `question.asked` and resumes once the
  last open prompt is answered. If a permission is auto-approved by config, you may see a
  brief pause/resume flicker. The SDK's v1 event types are stale, so these strings are
  matched at runtime via a cast.
- **Desired-state reconciliation:** playback is driven by a single computed flag — play only
  when `enabled && working && !awaitingUser` — recomputed synchronously on every event and
  applied through one serialized worker. This makes idle reliably pause (a queued resume can't
  replay after the turn ends) and prevents double-fire blips around prompts.
- **Automation permission** is required the first time, or `osascript` calls fail silently
  (`.nothrow()` keeps opencode stable).

## Roadmap

Planned work — no timelines promised (see the [experimental notice](#opencode-music)):

- **More coding agents.** Currently opencode-only; plan to support other agents that emit
  work/idle/prompt signals, including:
  - **Claude Code** (Anthropic's CLI)
  - **pi.dev**
- Extract a shared core so the Apple Music controller is agent-agnostic and each agent is a
  thin adapter over its own events.
- Configurable playlists and triggers per agent, plus playlist presets.

## Requirements

- macOS with the Music app (`/System/Applications/Music.app`) and AppleScript support.
- opencode (tested on `1.18.31`).
- An Apple Music library with the chosen playlist.

## Useful AppleScript commands

```bash
# current playback state: playing | paused | stopped
osascript -e 'tell application "Music" to get player state'

# start a playlist from the top
osascript -e 'tell application "Music" to play playlist "Trance Coding"'

# resume / pause
osascript -e 'tell application "Music" to play'
osascript -e 'tell application "Music" to pause'

# list playlists
osascript -e 'tell application "Music" to get name of every playlist'
```

## Development & tests

This repo is the source of truth for the plugin; it is installed into opencode by copying
the file. Node's built-in test runner is used — **no dependencies, no install step**.

```
apple-music.ts           # plugin source (installed to ~/.config/opencode/plugin/)
command/music.md         # /music slash command (installed to ~/.config/opencode/command/)
test/apple-music.test.ts # unit tests (node:test)
node_modules/@opencode-ai/plugin/  # minimal stub so the plugin imports in tests
package.json             # scripts: test, install-plugin
```

Run the tests (Node ≥ 22.6, uses `--experimental-strip-types`):

```bash
npm test
```

Install (or update) the plugin + slash command, then restart opencode:

```bash
npm run install-plugin   # copies apple-music.ts and command/music.md into ~/.config/opencode/
```

The tests drive the real plugin factory with a fake `$` shell that simulates Music's
player state, covering: playlist seeding, no-restart-while-playing, idle pause, permission
& question prompt pause/resume (including multiple pending prompts), enable/disable gating,
the on/off/toggle/status tool, dispose cleanup, and the "don't hijack existing playback"
rule.

## Disabling

- **Temporarily (no restart):** run `/music off` in opencode (see above).
- **Permanently:** remove the `"plugin": [...]` entry from `~/.config/opencode/opencode.json`
  (or delete the `.ts` file) and restart opencode. To disable just for one project, don't
  register it globally and omit it there instead.

# opencode-music

An [opencode](https://opencode.ai) plugin that plays an **Apple Music** playlist while
opencode is working ("thinking") and fades it out when it goes idle. Built for macOS.

## What it does

- When opencode starts a turn (`session.status` → `busy`), it starts or resumes the
  configured Apple Music playlist, with a short **fade-in**.
- When opencode finishes and goes idle (`session.status` → `idle` / `session.idle`),
  it **fades out** playback and pauses, restoring your original volume.
- When opencode **prompts you for input** (a permission request or a question), it fades
  out too, and resumes once you answer — so music never plays over a prompt.
- **Resume, not restart:** the playlist is loaded once; later turns resume the paused
  track at its saved position instead of restarting from the top.
- **Won't hijack your listening:** it only fades/pauses music that *it* started. If you
  were already playing something when opencode began, it leaves it alone.

## How it works

A plugin's `event({ event })` hook receives every bus event opencode emits. The relevant
signals per session are:

| Event | Meaning | Action |
| --- | --- | --- |
| `session.status` → `status.type === "busy"` | a turn started (working/thinking) | fade in / resume / seed playlist |
| `session.status` → `status.type === "idle"` | the turn finished | fade out + pause |
| `session.idle` | session idle (belt-and-suspenders) | fade out + pause |
| `permission.asked` / `question.asked` | opencode is waiting on you | fade out + pause |
| `permission.replied` / `question.replied` / `question.rejected` | you answered / dismissed | resume (once no prompts remain) |

Playback is driven through macOS **AppleScript** (`osascript`) via the Bun `$` shell the
plugin receives. Apple Music has no native fade command, so a fade ramps the app's
`sound volume` in an AppleScript `repeat`/`delay` loop, then restores the original value.

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
const PLAYLIST = "Armin van Buuren Essentials"
const FADE_MS = 500   // fade duration in ms (out on idle/prompt, in on resume)
const STEP = 10       // volume step 0-100 -> ~5 steps over FADE_MS
const FADE_IN = true  // also fade in when resuming
```

| Constant | Default | Description |
| --- | --- | --- |
| `PLAYLIST` | `"Armin van Buuren Essentials"` | Exact Apple Music playlist name to play. |
| `FADE_MS` | `500` | Fade duration in ms (out on idle/prompt, in on resume). |
| `STEP` | `10` | Volume step per tick (0–100); smaller = smoother, more AppleScript steps. |
| `FADE_IN` | `true` | Also fade in when resuming. Set `false` to snap back to full volume. |

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

### Fade tuning

| Goal | Settings |
| --- | --- |
| Snappy in/out (default) | `FADE_MS = 500`, `STEP = 10` |
| Slow, smooth fade | `FADE_MS = 1500`, `STEP = 5` |
| No fade at all | `FADE_MS = 0` or `STEP = 100` (single jump) |
| Fade out only (no fade in) | `FADE_IN = false` |

> Keep `FADE_MS ≤ ~1500`. Very long fades can overlap with a fast idle→busy transition.

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
/music off      # stop now (fade out) and skip future turns
/music toggle   # flip the current state
/music status   # report whether it is enabled
```

- State persists in `~/.config/opencode/.apple-music.json`; if the file is missing the
  plugin defaults to **enabled**.
- Turning it off fades out immediately if music was playing; turning it on takes effect on
  the next turn.
- You can also ask opencode directly, e.g. *"disable the background music"* — it calls the
  same tool.

## Behavior notes & gotchas

- **Playlist name must match exactly.** List yours with:
  `osascript -e 'tell application "Music" to get name of every playlist'`
- **Fade is global output volume**, not per-track; it's restored after each fade, so your
  manual volume setting is preserved.
- **Resume caveat:** plain `play` resumes whatever track Music last had loaded. The first
  turn of a session always seeds the playlist, so this only matters if you manually clear
  the queue mid-session.
- **Already playing?** If Music is playing when opencode starts working, it won't switch
  playlists or pause your audio — it only manages playback it initiated.
- **Prompts:** music pauses on `permission.asked` / `question.asked` and resumes once the
  last open prompt is answered. If a permission is auto-approved by config, you may see a
  brief pause/resume flicker. The SDK's v1 event types are stale, so these strings are
  matched at runtime via a cast.
- **Race condition:** an idle→busy within ~`FADE_MS` can land during a fade; keeping
  `FADE_MS ≤ 500` makes this negligible.
- **Automation permission** is required the first time, or `osascript` calls fail silently
  (`.nothrow()` keeps opencode stable).

## Requirements

- macOS with the Music app (`/System/Applications/Music.app`) and AppleScript support.
- opencode (tested on `1.18.31`).
- An Apple Music library with the chosen playlist.

## Useful AppleScript commands

```bash
# current playback state: playing | paused | stopped
osascript -e 'tell application "Music" to get player state'

# start a playlist from the top
osascript -e 'tell application "Music" to play playlist "Armin van Buuren Essentials"'

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

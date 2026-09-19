import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { tool, type Plugin } from "@opencode-ai/plugin"

const PLAYLIST = "Armin van Buuren Essentials"

// Fade duration (ms) and volume step (0-100). Base volume is always the user's current
// Apple Music `sound volume`, read at fade start and restored after fade-out.
// Override with env APPLE_MUSIC_FADE_MS / APPLE_MUSIC_FADE_STEP, or edit these defaults.
const FADE_MS = Number(process.env.APPLE_MUSIC_FADE_MS ?? 1500)
const STEP = Number(process.env.APPLE_MUSIC_FADE_STEP ?? 10)

const DEBUG = !!process.env.APPLE_MUSIC_DEBUG // set APPLE_MUSIC_DEBUG=1 to trace
const DEBUG_FILE = "/tmp/apple-music-debug.log"
const dbg = (m: string) => {
  if (!DEBUG) return
  try {
    appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${m}\n`)
  } catch {}
}

const STATE_FILE = join(homedir(), ".config", "opencode", ".apple-music.json")

// AppleScript double-quoted string literal.
const asQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

function readEnabled(): boolean {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")).enabled !== false // missing => enabled
  } catch {
    return true
  }
}

function writeEnabled(value: boolean): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify({ enabled: value }, null, 2))
}

export default (async ({ $ }) => {
  dbg(`init cwd=${process.cwd()} stateFile=${STATE_FILE}`)

  let enabled = readEnabled()
  const busy = new Set<string>() // sessions currently working
  const pending = new Set<string>() // open permission/question request ids
  let seeded = false // playlist loaded once? later turns just resume
  let weOwnMusic = false // only pause music that WE started
  let wantPlaying = false // single source of truth for the desired playback state

  // Desired playback is a pure function of live flags, recomputed synchronously on every
  // event. Ordering between busy/idle/prompt events can't race: the serialized worker always
  // reconciles to the latest value, so a stale resume just sees "should be paused".
  const desiredPlaying = () => enabled && busy.size > 0 && pending.size === 0

  let chain: Promise<void> = Promise.resolve()
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = chain.then(fn, fn)
    chain = result.then(
      () => {},
      () => {},
    )
    return result
  }

  const osa = async (s: string) => {
    const r = await $`osascript -e ${s}`.quiet().nothrow()
    if (DEBUG) {
      const rc = (r as any).exitCode
      const err = (((r as any).stderr?.toString()) || "").trim()
      dbg(`osa rc=${rc} err="${err}" body=${JSON.stringify(s.slice(0, 48))}`)
    }
    return r
  }
  const playing = async () =>
    (await osa(`tell application "Music" to get player state`)).stdout.toString().trim() === "playing"

  // Number of ramp steps and per-step delay, shared by both fades.
  const FADE_STEPS = Math.max(1, Math.ceil(100 / STEP))
  const FADE_DELAY = ((FADE_MS / 1000) / FADE_STEPS).toFixed(3)

  // Fade in to the user's current volume, running `startScript` (a `play`/`play playlist`) at
  // silence then ramping up. `sound volume` is read first so we fade toward whatever the user set.
  const fadeIn = async (startScript: string) => {
    return await osa(`tell application "Music"
	set b to sound volume
	set sound volume to 0
	${startScript}
	repeat with v from 0 to b by ${STEP}
		set sound volume to v
		delay ${FADE_DELAY}
	end repeat
end tell`)
  }

  // Fade out to silence, pause, then restore the user's original volume so playback isn't muted.
  const fadeOut = async () => {
    await osa(`tell application "Music"
	set b to sound volume
	repeat with v from b to 0 by -${STEP}
		set sound volume to v
		delay ${FADE_DELAY}
	end repeat
	pause
	set sound volume to b
end tell`)
  }

  // Brings actual playback in line with the current `wantPlaying`. Reads the live flag, so a
  // queued reconcile never plays over a newer pause. Fades use the user's own volume as base.
  const reconcile = async () => {
    const isPlaying = await playing()
    if (wantPlaying) {
      if (!isPlaying) {
        weOwnMusic = true
        if (!seeded) {
          const r = await fadeIn(`play playlist ${asQuote(PLAYLIST)}`)
          if ((r as any).exitCode === 0) seeded = true
          else dbg(`seed failed rc=${(r as any).exitCode}; will retry next turn`)
          return
        }
        await fadeIn("play")
      }
    } else {
      if (isPlaying && weOwnMusic) await fadeOut()
      weOwnMusic = false
    }
  }

  // Recompute the desired state and, only on a change, queue one reconcile. Returns the
  // queued work so callers can await it (keeps event handling deterministic).
  const recompute = (): Promise<void> => {
    const next = desiredPlaying()
    if (next === wantPlaying) return Promise.resolve()
    wantPlaying = next
    dbg(`wantPlaying -> ${next} (enabled=${enabled} busy=${busy.size} pending=${pending.size})`)
    return enqueue(reconcile)
  }

  return {
    event: async ({ event }) => {
      const ev = event as unknown as { type: string; properties: any }
      if (DEBUG && (ev.type.startsWith("session.") || ev.type.startsWith("permission.") || ev.type.startsWith("question.")))
        dbg(`event ${ev.type}${ev.type === "session.status" ? ":" + ev.properties?.status?.type : ""}`)
      switch (ev.type) {
        case "session.status": {
          const { sessionID, status } = ev.properties
          if (status.type === "busy") busy.add(sessionID)
          else if (status.type === "idle") {
            busy.delete(sessionID)
            pending.clear() // a finished turn ends any open prompt too
          }
          await recompute()
          break
        }
        case "session.idle": {
          busy.delete(ev.properties.sessionID)
          pending.clear()
          await recompute()
          break
        }
        // opencode is prompting the user (permission request / question): pause.
        case "permission.asked":
        case "question.asked": {
          pending.add(ev.properties.id)
          await recompute()
          break
        }
        // user answered / dismissed: resume if we're still working.
        case "permission.replied":
        case "question.replied":
        case "question.rejected": {
          pending.delete(ev.properties.requestID)
          await recompute()
          break
        }
      }
    },

    tool: {
      apple_music: tool({
        description:
          "Enable or disable Apple Music playback while opencode works. action: on | off | toggle | status.",
        args: {
          action: tool.schema.enum(["on", "off", "toggle", "status"]).optional().describe("Defaults to status."),
        },
        async execute(args) {
          const action = args.action ?? "status"
          if (action === "status") return `Apple Music plugin is ${enabled ? "enabled" : "disabled"}.`
          enabled = action === "on" ? true : action === "off" ? false : !enabled
          writeEnabled(enabled)
          await recompute() // turning off pauses now; turning on resumes on the next working turn
          return `Apple Music plugin ${enabled ? "enabled" : "disabled"}.`
        },
      }),
    },

    dispose: async () => {
      await enqueue(async () => {
        if (weOwnMusic) {
          await fadeOut()
          weOwnMusic = false
        }
      })
    },
  }
}) satisfies Plugin

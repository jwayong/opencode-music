import { appendFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { tool, type Plugin } from "@opencode-ai/plugin"

const PLAYLIST = "Armin van Buuren Essentials"
const FADE_MS = 500 // fade duration in ms (out on idle, in on resume)
const STEP = 10 // volume step 0-100 -> ~5 steps over FADE_MS
const FADE_IN = true // also fade in when resuming

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

async function readEnabled(): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8"))
    return parsed.enabled !== false // missing file / field => enabled
  } catch {
    return true
  }
}

async function writeEnabled(value: boolean): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify({ enabled: value }, null, 2))
}

export default (async ({ $ }) => {
  dbg(`init cwd=${process.cwd()} stateFile=${STATE_FILE}`)
  const busy = new Set<string>()
  let seeded = false // playlist loaded once? later turns just resume
  let weOwnMusic = false // only pause music that WE started
  const pending = new Set<string>() // open permission/question request ids
  let pausedForPrompt = false // did a user prompt cause the current pause?

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

  const fadeOutPause = async () => {
    if (!weOwnMusic) return
    weOwnMusic = false
    const delay = ((FADE_MS / 1000) / Math.ceil(100 / STEP)).toFixed(3)
    await osa(`tell application "Music"
      set b to sound volume
      repeat with v from b to 0 by -${STEP}
        set sound volume to v
        delay ${delay}
      end repeat
      pause
      set sound volume to b
    end tell`)
  }

  const resumeOrStart = async () => {
    if (await playing()) return
    weOwnMusic = true
    if (!seeded) {
      const r = await osa(`tell application "Music" to play playlist ${asQuote(PLAYLIST)}`)
      if ((r as any).exitCode === 0) seeded = true
      else dbg(`seed failed rc=${(r as any).exitCode}; will retry next turn`)
      return
    }
    if (FADE_IN) {
      const delay = ((FADE_MS / 1000) / Math.ceil(100 / STEP)).toFixed(3)
      await osa(`tell application "Music"
        set b to sound volume
        set sound volume to 0
        play
        repeat with v from 0 to b by ${STEP}
          set sound volume to v
          delay ${delay}
        end repeat
      end tell`)
    } else {
      await osa(`tell application "Music" to play`)
    }
  }

  const pauseForUser = async () => {
    if (!weOwnMusic) return // nothing we started is playing -> nothing to do
    pausedForPrompt = true
    await fadeOutPause()
  }

  const resumeFromPrompt = async () => {
    if (!pausedForPrompt) return
    pausedForPrompt = false
    if (await readEnabled()) await resumeOrStart()
  }

  return {
    event: async ({ event }) => {
      const ev = event as unknown as { type: string; properties: any }
      if (DEBUG && (ev.type.startsWith("session.") || ev.type.startsWith("permission.") || ev.type.startsWith("question.")))
        dbg(`event ${ev.type}${ev.type === "session.status" ? ":" + ev.properties?.status?.type : ""}`)
      switch (ev.type) {
        case "session.status": {
          const { sessionID, status } = ev.properties
          if (status.type === "busy") {
            busy.add(sessionID)
            if (await readEnabled()) await resumeOrStart()
          } else if (status.type === "idle") {
            busy.delete(sessionID)
            pending.clear()
            pausedForPrompt = false
            if (!busy.size) await fadeOutPause() // always clean up, even if disabled
          }
          break
        }
        case "session.idle": {
          busy.delete(ev.properties.sessionID)
          pending.clear()
          pausedForPrompt = false
          if (!busy.size) await fadeOutPause()
          break
        }
        // opencode is prompting the user (permission request / question): pause.
        case "permission.asked":
        case "question.asked": {
          pending.add(ev.properties.id)
          if (await readEnabled()) await pauseForUser()
          break
        }
        // user answered / dismissed: resume once nothing is pending.
        case "permission.replied":
        case "question.replied":
        case "question.rejected": {
          pending.delete(ev.properties.requestID)
          if (!pending.size) await resumeFromPrompt()
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
          if (action === "status") {
            return `Apple Music plugin is ${await readEnabled() ? "enabled" : "disabled"}.`
          }
          const next = action === "on" ? true : action === "off" ? false : !(await readEnabled())
          await writeEnabled(next)
          if (!next) await fadeOutPause() // stop immediately if it was playing
          return `Apple Music plugin ${next ? "enabled" : "disabled"}.`
        },
      }),
    },

    dispose: async () => {
      await fadeOutPause()
    },
  }
}) satisfies Plugin

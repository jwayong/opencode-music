import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolate the plugin's on-disk enable/disable state to a throwaway HOME.
// Must run BEFORE importing the plugin module (it resolves STATE_FILE at load).
process.env.HOME = mkdtempSync(join(tmpdir(), "apple-music-test-"))
const STATE_FILE = join(process.env.HOME, ".config", "opencode", ".apple-music.json")

const Plugin = (await import("../apple-music.ts")).default

type Hooks = Awaited<ReturnType<typeof Plugin>>
type EventInput = Parameters<NonNullable<Hooks["event"]>>[0]

// A fake Bun `$` shell that records osascript invocations and simulates Music's
// player state so play/pause transitions behave like the real app.
function makeShell(initial: "playing" | "paused" | "stopped" = "stopped") {
  const calls: string[] = []
  let playerState = initial

  const ok = (out = "") => ({ stdout: Buffer.from(out), stderr: Buffer.from(""), exitCode: 0 })

  const run = (script: string) => {
    calls.push(script)
    if (script.includes("get player state")) return Promise.resolve(ok(playerState + "\n"))
    if (script.includes("pause")) {
      playerState = "paused"
      return Promise.resolve(ok())
    }
    if (script.includes("play")) {
      playerState = "playing"
      return Promise.resolve(ok())
    }
    return Promise.resolve(ok())
  }

  const $ = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const script = values.map(String).join("")
    let pending: Promise<{ stdout: Buffer }> | undefined
    const api = {
      quiet() {
        return api
      },
      nothrow() {
        return api
      },
      then(res: (v: { stdout: Buffer }) => unknown, rej: (e: unknown) => unknown) {
        if (!pending) pending = run(script)
        return pending.then(res, rej)
      },
    }
    return api
  }

  return { $, calls, state: () => playerState, reset: () => (calls.length = 0) }
}

async function setup() {
  const shell = makeShell()
  const hooks = await Plugin({ $: shell.$ } as never)
  const send = (type: string, properties: Record<string, unknown> = {}) =>
    hooks.event!({ event: { type, properties } } as unknown as EventInput)
  const tool_ = (action?: "on" | "off" | "toggle" | "status") =>
    hooks.tool!.apple_music.execute(action === undefined ? {} : ({ action } as never), {} as never)
  return { shell, hooks, send, tool: tool_ }
}

beforeEach(() => {
  rmSync(STATE_FILE, { force: true }) // reset to default (enabled) between tests
})

test("busy seeds the playlist once and does not restart while playing", async () => {
  const { shell, send } = await setup()

  await send("session.status", { status: { type: "busy" } })
  assert.ok(shell.calls.some((c) => c.includes("play playlist")), "playlist should be seeded on first busy")
  assert.equal(shell.state(), "playing")

  shell.reset()
  await send("session.status", { status: { type: "busy" } }) // already playing -> no restart
  assert.ok(!shell.calls.some((c) => c.includes("play playlist")), "should not re-seed while already playing")
})

test("idle pauses playback", async () => {
  const { shell, send } = await setup()

  await send("session.status", { status: { type: "busy" } })
  shell.reset()
  await send("session.status", { status: { type: "idle" } })

  assert.ok(shell.calls.some((c) => c.includes("pause")), "idle should pause")
  assert.equal(shell.state(), "paused")
})

test("permission prompt pauses, reply resumes", async () => {
  const { shell, send } = await setup()

  await send("session.status", { status: { type: "busy" } })
  shell.reset()

  await send("permission.asked", { id: "p1" })
  assert.ok(shell.calls.some((c) => c.includes("pause")), "asked should pause")
  assert.equal(shell.state(), "paused")

  shell.reset()
  await send("permission.replied", { requestID: "p1" })
  assert.ok(shell.calls.some((c) => c.includes("play")), "reply should resume playback")
  assert.equal(shell.state(), "playing")
})

test("question prompt pauses; rejected resumes once nothing is pending", async () => {
  const { shell, send } = await setup()

  await send("session.status", { status: { type: "busy" } })
  shell.reset()

  await send("question.asked", { id: "q1" })
  assert.equal(shell.state(), "paused")

  shell.reset()
  await send("question.rejected", { requestID: "q1" })
  assert.ok(shell.calls.some((c) => c.includes("play")), "reject should resume")
  assert.equal(shell.state(), "playing")
})

test("multiple pending prompts only resume after the last one is answered", async () => {
  const { shell, send } = await setup()

  await send("session.status", { status: { type: "busy" } })
  await send("permission.asked", { id: "p1" })
  await send("question.asked", { id: "q1" })
  assert.equal(shell.state(), "paused")

  shell.reset()
  await send("question.replied", { requestID: "q1" }) // p1 still open
  assert.ok(!shell.calls.some((c) => c.includes("play")), "must stay paused while a prompt is pending")
  assert.equal(shell.state(), "paused")

  await send("permission.replied", { requestID: "p1" }) // last one -> resume
  assert.ok(shell.calls.some((c) => c.includes("play")), "should resume after last prompt answered")
  assert.equal(shell.state(), "playing")
})

test("disabled plugin does not start playback on busy", async () => {
  const { shell, send, tool } = await setup()

  await tool("off")
  shell.reset()
  await send("session.status", { status: { type: "busy" } })

  assert.ok(!shell.calls.some((c) => c.includes("play")), "disabled -> no playback")
})

test("turning off while playing pauses immediately", async () => {
  const { shell, send, tool } = await setup()

  await send("session.status", { status: { type: "busy" } })
  assert.equal(shell.state(), "playing")
  shell.reset()

  await tool("off")
  assert.ok(shell.calls.some((c) => c.includes("pause")), "off should pause current playback")
  assert.equal(shell.state(), "paused")
})

test("tool status/on/off/toggle reflect the persisted state", async () => {
  const { tool } = await setup()

  assert.match(await tool("status"), /enabled/) // default when file missing
  await tool("off")
  assert.match(await tool("status"), /disabled/)
  await tool("on")
  assert.match(await tool("status"), /enabled/)
  await tool("toggle")
  assert.match(await tool("status"), /disabled/)
})

test("dispose pauses music that the plugin started", async () => {
  const { shell, send, hooks } = await setup()

  await send("session.status", { status: { type: "busy" } })
  shell.reset()
  await hooks.dispose!()

  assert.ok(shell.calls.some((c) => c.includes("pause")), "dispose should pause")
})

test("does not pause music it did not start", async () => {
  // Music was already playing before opencode started working: plugin must not hijack.
  const shell = makeShell("playing")
  const hooks = await Plugin({ $: shell.$ } as never)
  const send = (type: string, properties: Record<string, unknown> = {}) =>
    hooks.event!({ event: { type, properties } } as unknown as EventInput)

  await send("session.status", { status: { type: "busy" } }) // sees playing -> does not take ownership
  shell.reset()
  await send("session.status", { status: { type: "idle" } })

  assert.ok(!shell.calls.some((c) => c.includes("pause")), "should not pause user's own playback")
})

test("regression: seed command quotes the playlist name (AppleScript needs a string literal)", async () => {
  const { shell, send } = await setup()

  await send("session.status", { status: { type: "busy" } })
  const seed = shell.calls.find((c) => c.includes("play playlist"))
  assert.ok(seed, "a play-playlist seed command should be emitted")
  assert.match(seed!, /play playlist "Armin van Buuren Essentials"/, "playlist name must be double-quoted")
  assert.ok(!/play playlist Armin/.test(seed!), "must not emit an unquoted identifier (causes -2740)")
})

test("regression: a burst of resume events after a prompt yields a single play", async () => {
  const { shell, send } = await setup()

  await send("session.status", { status: { type: "busy" } }) // seed -> playing
  await send("permission.asked", { id: "p1" }) // pause for prompt
  assert.equal(shell.state(), "paused")
  shell.reset()

  // Reply + work-resume events arrive together (the scenario that used to double-fire).
  await Promise.all([
    send("permission.replied", { requestID: "p1" }),
    send("session.status", { status: { type: "busy" } }),
    send("session.status", { status: { type: "busy" } }),
  ])

  const plays = shell.calls.filter((c) => c.includes("to play") && !c.includes("playlist")) // resume plays
  assert.equal(plays.length, 1, `expected exactly one resume play, got ${plays.length}`)
  assert.equal(shell.state(), "playing")
})

test("never manipulates sound volume (respects the user's setting)", async () => {
  const { shell, send } = await setup()

  // Exercise every transition that previously touched volume.
  await send("session.status", { status: { type: "busy" } }) // seed
  await send("permission.asked", { id: "p1" }) // pause for prompt
  await send("permission.replied", { requestID: "p1" }) // resume
  await send("question.asked", { id: "q1" }) // pause
  await send("question.rejected", { requestID: "q1" }) // resume
  await send("session.status", { status: { type: "idle" } }) // pause (turn done)

  const volumeOps = shell.calls.filter((c) => c.includes("sound volume"))
  assert.equal(volumeOps.length, 0, `plugin must not set sound volume, got: ${JSON.stringify(volumeOps)}`)
})


test("regression: redundant resume triggers while already playing are no-ops", async () => {
  const { shell, send } = await setup()

  await send("session.status", { status: { type: "busy" } }) // seed -> playing
  shell.reset()

  await Promise.all([
    send("session.status", { status: { type: "busy" } }),
    send("session.status", { status: { type: "busy" } }),
    send("permission.replied", { requestID: "nope" }),
  ])

  // "get player state" contains the substring "play", so exclude it when checking for
  // actual playback-changing commands (seed / bare play / fade-in).
  const changes = shell.calls.filter((c) => c.includes("play") && !c.includes("player"))
  assert.equal(changes.length, 0, `expected no playback commands while already playing, got: ${JSON.stringify(changes)}`)
})

test("regression: a busy+idle burst never leaves music playing (no stale resume)", async () => {
  const { shell, send } = await setup()

  // A turn that starts and ends in the same tick. Previously the queued resume from `busy`
  // could run after the idle pause and leave playback running.
  await Promise.all([
    send("session.status", { status: { type: "busy" } }),
    send("session.status", { status: { type: "idle" } }),
    send("session.idle"),
  ])

  const plays = shell.calls.filter((c) => c.includes("to play") && !c.includes("playlist"))
  assert.notEqual(shell.state(), "playing", "must not be left playing after idle")
  assert.equal(plays.length, 0, `stale resume fired: ${JSON.stringify(plays)}`)
})

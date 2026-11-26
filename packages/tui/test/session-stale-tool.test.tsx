import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import type { SessionMessageInfo } from "@opencode/client"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const session = {
  id: "ses_stale_tool",
  title: "Stale tool",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const messages = [
  { type: "user", id: "user-1", text: "Run it", time: { created: 0 } },
  {
    type: "assistant",
    id: "assistant-1",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "call-stale",
        name: "shell",
        time: { created: 1, ran: 1 },
        state: { input: { command: "echo hello && sleep 600" }, status: "running", metadata: {} },
      },
    ],
  },
] as SessionMessageInfo[]

async function boot(running: boolean) {
  const state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox` || url.pathname === `/api/session/${session.id}/permission`)
      return json({ data: [] })
    if (running && url.pathname === "/api/session/active")
      return json({ data: { [session.id]: { type: "running" } } })
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, tabs: { enabled: false }, session: { verbosity: "high" } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: session.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  return {
    setup,
    async [Symbol.asyncDispose]() {
      setup.renderer.destroy()
      await task
      await server.stop()
      await state[Symbol.asyncDispose]()
    },
  }
}

test("an idle session shows a stale shell call as stopped", async () => {
  await using app = await boot(false)
  await app.setup.waitForFrame((frame) => frame.includes("$ echo hello && sleep 600"))
  await app.setup.waitForVisualIdle({ quietFrames: 3 })
  const frame = app.setup.captureCharFrame()
  expect(frame).toContain("$ echo hello && sleep 600")
  expect(frame).not.toContain("move running work to the background")
})

test("a running session keeps the shell call spinner", async () => {
  await using app = await boot(true)
  await app.setup.waitForFrame((frame) => frame.includes("echo hello && sleep 600") && !frame.includes("$ echo hello"))
  await app.setup.waitForVisualIdle({ quietFrames: 3 })
  expect(app.setup.captureCharFrame()).not.toContain("$ echo hello")
})

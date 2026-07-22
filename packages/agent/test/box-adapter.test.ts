import { describe, expect, it, vi } from "vitest"

import { createBoxHarnessSandbox } from "../src/harness/box-sandbox.ts"
import { shareBoxSessions } from "../src/harness/shared-box.ts"

import type { Box, BoxSession } from "@vite-hub/box"

describe("Box harness adapter", () => {
  it("preserves a provider-specific authoritative Box cwd", async () => {
    const exec = vi.fn(async () => ({ code: 0, ok: true, stderr: "", stdout: "" }))
    const box: Box = {
      plan: plan(),
      async open() { return boxSession({ cwd: "/host/repository", exec }) },
    }

    const harness = await createBoxHarnessSandbox(box).createSession()
    expect(harness.defaultWorkingDirectory).toBe("/host/repository")
    await harness.run({ command: "pwd", workingDirectory: "/host/repository" })
    expect(exec).toHaveBeenCalledWith("sh", ["-lc", "pwd"], expect.objectContaining({ cwd: "/host/repository" }))
    await harness.destroy?.()
  })

  it("opens a shared Box without a Harness driver", async () => {
    const session = boxSession()
    const open = vi.fn(async () => session)
    const shared = shareBoxSessions({ plan: plan(), open })

    const lease = await shared.open()

    expect(open).toHaveBeenCalledOnce()
    expect(lease.id).toBe(session.id)
    await lease.close()
  })

  it("coordinates one physical session when Workspace opens before Harness", async () => {
    const close = vi.fn(async () => {})
    const session = boxSession({ close })
    const open = vi.fn(async (options: Parameters<Box["open"]>[0]) => {
      await options?.initialize?.(session, { signal: options.signal })
      return session
    })
    const shared = shareBoxSessions({ plan: plan(), open })
    const workspaceLease = shared.open()
    const initialized = vi.fn(async () => {})
    const harness = await createBoxHarnessSandbox(shared).createSession({
      onFirstCreate: initialized,
      sessionId: "harness-session",
    })
    const workspace = await workspaceLease

    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "harness-session" }))
    expect(initialized).toHaveBeenCalledOnce()
    expect(harness.id).toBe("physical-session")
    expect(harness.ports).toEqual([])

    await harness.destroy?.()
    expect(close).not.toHaveBeenCalled()
    await workspace.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it("leases the in-flight session when Workspace opens during Harness initialization", async () => {
    const session = boxSession()
    const open = vi.fn(async (options: Parameters<Box["open"]>[0]) => {
      await options?.initialize?.(session, { signal: options.signal })
      return session
    })
    const shared = shareBoxSessions({ plan: plan(), open })
    let workspaceLease: BoxSession | undefined

    const harness = await createBoxHarnessSandbox(shared).createSession({
      async onFirstCreate() {
        workspaceLease = await shared.open()
      },
    })

    expect(open).toHaveBeenCalledOnce()
    expect(workspaceLease?.id).toBe(session.id)
    await harness.destroy?.()
    await workspaceLease?.close()
  })

  it("rejects and closes a Box without process spawning", async () => {
    const close = vi.fn(async () => {})
    const session = boxSession({ close, spawn: undefined })
    const box: Box = { plan: plan(), async open() { return session } }

    await expect(createBoxHarnessSandbox(box).createSession()).rejects.toThrow("require a Box runtime with process spawning")
    expect(close).toHaveBeenCalledOnce()
  })

  it("preserves the Box runtime's declared port pool", async () => {
    const expose = vi.fn(async () => new URL("https://box.example.com:4321"))
    const session = boxSession({ ports: { expose, values: [4321] } })
    const box: Box = { plan: plan(), async open() { return session } }

    const harness = await createBoxHarnessSandbox(box).createSession()
    expect(harness.ports).toEqual([4321])
    await expect(harness.getPortUrl({ port: 4321 })).resolves.toBe("https://box.example.com:4321/")
    expect(expose).toHaveBeenCalledWith(4321, { protocol: "http" })
    await harness.destroy?.()
  })

  it("keeps failed Harness initialization inside the runtime rollback boundary", async () => {
    const close = vi.fn(async () => {})
    const session = boxSession({ close })
    const open = vi.fn(async (options: Parameters<Box["open"]>[0]) => {
      expect(options?.initialize).toBeTypeOf("function")
      try {
        await options?.initialize?.(session, { signal: options.signal })
      }
      catch (error) {
        await session.close()
        throw error
      }
      return session
    })
    const shared = shareBoxSessions({ plan: plan(), open })

    await expect(createBoxHarnessSandbox(shared).createSession({
      async onFirstCreate() {
        throw new Error("bootstrap failed")
      },
    })).rejects.toThrow("bootstrap failed")
    expect(close).toHaveBeenCalledOnce()
    expect(open.mock.calls[0]?.[0]?.initialize).toBeTypeOf("function")
  })
})

function plan() {
  return {
    cache: { state: "disposable" as const },
    environment: { env: {} },
    identity: "fixture",
    isolation: "microvm" as const,
    requirements: [],
    runtime: "fixture",
    workspace: { state: "disposable" as const, workDir: "." as const },
  }
}

function boxSession(overrides: Partial<BoxSession> = {}): BoxSession {
  return {
    id: "physical-session",
    cwd: "/workspace",
    files: {
      async exists() { return false },
      async list() { return [] },
      async mkdir() {},
      async read() { return null },
      async remove() {},
      async write() {},
    },
    async close() {},
    async exec() { return { code: 0, ok: true, stderr: "", stdout: "" } },
    async spawn() {
      return {
        stderr: new ReadableStream(),
        stdout: new ReadableStream(),
        async kill() {},
        async wait() { return { code: 0 } },
      }
    },
    ...overrides,
  }
}

import { randomUUID } from "node:crypto"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { describe, expect, it, vi } from "vitest"

import type { HarnessV1SandboxProvider } from "@ai-sdk/harness"
import { createLocalHarnessSandbox } from "../src/harness/local-sandbox.ts"
import { adaptLocalHarnessSandbox } from "../src/internal/local-sandbox.ts"

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve(server))
  })
}

function close(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve()
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

function localProcesses(session: unknown) {
  return (session as { processes: Set<{ child: ChildProcessWithoutNullStreams }> }).processes
}

const ignoresTermination = "node -e \"process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)\""

async function spawnReady(
  session: Awaited<ReturnType<HarnessV1SandboxProvider["createSession"]>>,
  abortSignal: AbortSignal,
  command = ignoresTermination,
) {
  const child = await session.spawn({ abortSignal, command })
  const reader = child.stdout.getReader()
  await reader.read()
  reader.releaseLock()
  return child
}

function forceKillGroup(pid: number | undefined, kill = process.kill.bind(process)) {
  if (!pid) return
  try {
    kill(-pid, "SIGKILL")
  }
  catch {}
}

function mockProcessLiveness(deadPids: readonly number[] = []) {
  return vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (deadPids.includes(pid)) throw Object.assign(new Error("Process not found"), { code: "ESRCH" })
    return true
  })
}

async function ownerFixture(pid: number) {
  const root = join(tmpdir(), "vitehub-harness", `owner-${pid}-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, "keep.txt"), "keep")
  return root
}

describe("local harness sandbox", () => {
  it("declares whether it inherits the ambient environment", () => {
    expect(createLocalHarnessSandbox().executionAuthority).toMatchObject({
      credentials: "ambient",
      environment: "ambient",
      filesystem: { access: "read-write", scope: "host" },
      isolation: "none",
      network: "unrestricted",
      processes: "arbitrary",
    })
    expect(createLocalHarnessSandbox({ env: { PATH: process.env.PATH } }).executionAuthority)
      .toMatchObject({ credentials: "unknown", environment: "selected" })
  })

  it("keeps session ids inside the local sandbox root", async () => {
    const session = await createLocalHarnessSandbox().createSession({ sessionId: "../../outside" })

    try {
      const [owner, sessionRoot] = relative(join(tmpdir(), "vitehub-harness"), (session as unknown as { rootDir: string }).rootDir).split(/[\\/]/)
      expect(owner).toMatch(/^owner-\d+-[0-9a-f-]{36}$/)
      expect(sessionRoot).toMatch(/^[a-f0-9]{64}$/)
    }
    finally {
      await session.destroy?.()
    }
  })

  it("removes managed session roots on destroy", async () => {
    const session = await createLocalHarnessSandbox().createSession({ sessionId: `cleanup-${randomUUID()}` })
    const root = (session as unknown as { rootDir: string }).rootDir

    await session.destroy?.()

    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("puts anonymous cleanup roots under the process owner", async () => {
    const session = await createLocalHarnessSandbox().createSession()
    const root = (session as unknown as { rootDir: string }).rootDir

    try {
      const [owner, sessionRoot] = relative(join(tmpdir(), "vitehub-harness"), root).split(/[\\/]/)
      expect(owner).toMatch(/^owner-\d+-[0-9a-f-]{36}$/)
      expect(sessionRoot).toMatch(/^session-/)
    }
    finally {
      await session.destroy?.()
    }
  })

  it("preserves cleanup-disabled session roots across providers", async () => {
    const sessionId = `persistent-${randomUUID()}`
    const persistent = await createLocalHarnessSandbox({ cleanup: false }).createSession({ sessionId })
    const root = (persistent as unknown as { rootDir: string }).rootDir
    await persistent.writeTextFile({ content: "keep", path: "keep.txt" })

    try {
      await persistent.destroy?.()
      const managed = await createLocalHarnessSandbox().createSession({ sessionId: `managed-${randomUUID()}` })

      try {
        expect(relative(join(tmpdir(), "vitehub-harness"), root)).toMatch(/^[a-f0-9]{64}$/)
        await expect(readFile(join(root, "keep.txt"), "utf8")).resolves.toBe("keep")
      }
      finally {
        await managed.destroy?.()
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("reclaims roots owned by dead processes", async () => {
    const deadPid = 4242
    const abandoned = await ownerFixture(deadPid)
    const kill = mockProcessLiveness([deadPid])
    let session: Awaited<ReturnType<HarnessV1SandboxProvider["createSession"]>> | undefined

    try {
      session = await createLocalHarnessSandbox().createSession({ sessionId: `reclaim-${randomUUID()}` })

      await vi.waitFor(async () => await expect(stat(abandoned)).rejects.toMatchObject({ code: "ENOENT" }))
    }
    finally {
      kill.mockRestore()
      await session?.destroy?.()
      await rm(abandoned, { force: true, recursive: true })
    }
  })

  it("preserves roots owned by live processes", async () => {
    const live = await ownerFixture(4243)
    const kill = mockProcessLiveness()
    let session: Awaited<ReturnType<HarnessV1SandboxProvider["createSession"]>> | undefined

    try {
      session = await createLocalHarnessSandbox().createSession({ sessionId: `preserve-${randomUUID()}` })

      await expect(readFile(join(live, "keep.txt"), "utf8")).resolves.toBe("keep")
    }
    finally {
      kill.mockRestore()
      await session?.destroy?.()
      await rm(live, { force: true, recursive: true })
    }
  })

  it("does not delete unrelated directories", async () => {
    const unrelated = join(tmpdir(), "vitehub-harness", `unrelated-${randomUUID()}`)
    await mkdir(unrelated, { recursive: true })
    await writeFile(join(unrelated, "keep.txt"), "keep")
    const kill = mockProcessLiveness()
    let session: Awaited<ReturnType<HarnessV1SandboxProvider["createSession"]>> | undefined

    try {
      session = await createLocalHarnessSandbox().createSession({ sessionId: `unrelated-${randomUUID()}` })

      await expect(readFile(join(unrelated, "keep.txt"), "utf8")).resolves.toBe("keep")
    }
    finally {
      kill.mockRestore()
      await session?.destroy?.()
      await rm(unrelated, { force: true, recursive: true })
    }
  })

  it("resumes the same session root", async () => {
    const provider = createLocalHarnessSandbox()
    const first = await provider.createSession({ sessionId: "thread-1" })
    const resumed = await provider.resumeSession!({ sessionId: "thread-1" })

    try {
      expect(resumed.defaultWorkingDirectory).toBe(first.defaultWorkingDirectory)
    }
    finally {
      await resumed.destroy?.()
    }
  })

  it("adapts bootstrap commands to the local session root", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" }))
    const rawSession = { defaultWorkingDirectory: "/session", restricted: () => ({ run }), run }
    const provider = adaptLocalHarnessSandbox({
      createSession: async (options: Parameters<HarnessV1SandboxProvider["createSession"]>[0]) => {
        await options?.onFirstCreate?.(rawSession as never, {})
        return rawSession as never
      },
      resumeSession: async () => rawSession,
      specificationVersion: "harness-sandbox-v1",
    }, "/tmp/harness/example")!
    const session = await (provider as HarnessV1SandboxProvider).createSession({
      onFirstCreate: async session => {
        await session.run({ command: "pnpm --dir /tmp/harness/example bootstrap" })
      },
    })

    await session.run({ command: "pnpm --dir /tmp/harness/example install" })

    expect(run).toHaveBeenNthCalledWith(1, { command: "pnpm --dir /session/tmp/harness/example bootstrap" })
    expect(run).toHaveBeenNthCalledWith(2, { command: "pnpm --dir /session/tmp/harness/example install" })
  })

  it("does not serialize bootstrap work for independent roots", async () => {
    const provider = createLocalHarnessSandbox()
    let releaseFirst!: () => void
    const firstReady = new Promise<void>(resolve => releaseFirst = resolve)
    let markSecondStarted!: () => void
    const secondStarted = new Promise<void>(resolve => markSecondStarted = resolve)

    const first = provider.createSession({
      onFirstCreate: async () => await firstReady,
    })
    const second = provider.createSession({
      onFirstCreate: async () => markSecondStarted(),
    })

    try {
      await secondStarted
      releaseFirst()
      const sessions = await Promise.all([first, second])
      await Promise.all(sessions.map(session => session.destroy?.()))
    }
    finally {
      releaseFirst()
    }
  })

  it("serializes bootstrap work and releases the queue after failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-local-sandbox-"))
    const provider = createLocalHarnessSandbox({ rootDir: root })
    const events: string[] = []
    let releaseFirst!: () => void
    const firstReady = new Promise<void>(resolve => releaseFirst = resolve)
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => markFirstStarted = resolve)

    const first = provider.createSession({
      onFirstCreate: async () => {
        events.push("first:start")
        markFirstStarted()
        await firstReady
        events.push("first:fail")
        throw new Error("bootstrap failed")
      },
    })
    const second = provider.createSession({
      onFirstCreate: async () => {
        events.push("second:start")
      },
    })

    try {
      await firstStarted
      expect(events).toEqual(["first:start"])

      releaseFirst()
      await expect(first).rejects.toThrow("bootstrap failed")
      const secondSession = await second

      try {
        expect(events).toEqual(["first:start", "first:fail", "second:start"])
      }
      finally {
        await secondSession.destroy?.()
      }
    }
    finally {
      releaseFirst()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("runs commands and reads written files", async () => {
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH } })
    const session = await provider.createSession()

    try {
      await session.writeTextFile({ content: "hello", path: "input.txt" })

      const result = await session.run({ command: "cat input.txt" })

      expect(provider.bridgePorts).toBeUndefined()
      expect(session.description).toBe("Workspace shell.")
      expect(session.ports).toEqual([0])
      expect(result).toMatchObject({ exitCode: 0, stdout: "hello" })
      await expect(session.getPortUrl({ port: 0, protocol: "ws" })).resolves.toBe("ws://127.0.0.1:0")
    }
    finally {
      await session.destroy?.()
    }
  })

  it("stops commands and preserves the caller's abort reason", async () => {
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH } })
    const session = await provider.createSession()
    const abort = new AbortController()
    const reason = new Error("client disconnected")

    try {
      const child = await session.spawn({
        abortSignal: abort.signal,
        command: "node -e \"setInterval(() => {}, 1000)\"",
      })

      abort.abort(reason)

      await expect(child.wait()).rejects.toBe(reason)
      expect(localProcesses(session).size).toBe(0)
      expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
      await expect(child.kill()).resolves.toBeUndefined()
    }
    finally {
      await session.destroy?.()
    }
  })

  it.skipIf(process.platform === "win32")("escalates when a command ignores termination", async () => {
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH } })
    const session = await provider.createSession()
    const abort = new AbortController()
    const reason = new Error("client disconnected")
    let child: Awaited<ReturnType<typeof session.spawn>> | undefined

    try {
      child = await spawnReady(session, abort.signal)

      abort.abort(reason)

      const outcome = await Promise.race([
        Promise.resolve(child.wait()).catch((error: unknown) => error),
        new Promise(resolve => setTimeout(() => resolve("timed out"), 2_000)),
      ])
      expect(outcome).toBe(reason)
      expect(localProcesses(session).size).toBe(0)
      await vi.waitFor(() => {
        expect(() => process.kill(-child!.pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
      })
    }
    finally {
      forceKillGroup(child?.pid)
      await session.destroy?.()
    }
  })

  it.skipIf(process.platform === "win32")("cleans descendants after the shell leader exits", async () => {
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH } })
    const session = await provider.createSession()
    const abort = new AbortController()
    const reason = new Error("client disconnected")
    let child: Awaited<ReturnType<typeof session.spawn>> | undefined

    try {
      child = await spawnReady(session, abort.signal, "sh -c 'trap \"\" TERM; echo ready; sleep 30' &")
      const [{ child: rawChild }] = localProcesses(session)
      if (rawChild!.exitCode === null && rawChild!.signalCode === null) {
        await new Promise<void>(resolve => rawChild!.once("exit", () => resolve()))
      }

      expect(rawChild!.exitCode).toBe(0)
      abort.abort(reason)

      await expect(child.wait()).rejects.toBe(reason)
      expect(localProcesses(session).size).toBe(0)
      await vi.waitFor(() => {
        expect(() => process.kill(-child!.pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
      })
    }
    finally {
      forceKillGroup(child?.pid)
      await session.destroy?.()
    }
  })

  it.skipIf(process.platform === "win32")("retains ownership when forced termination does not close", async () => {
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH } })
    const session = await provider.createSession()
    const abort = new AbortController()
    const reason = new Error("client disconnected")
    const realKill = process.kill.bind(process)
    let child: Awaited<ReturnType<typeof session.spawn>> | undefined
    let kill: ReturnType<typeof vi.spyOn> | undefined
    let rawChild: ChildProcessWithoutNullStreams | undefined

    try {
      child = await spawnReady(session, abort.signal)
      rawChild = Array.from(localProcesses(session))[0]?.child
      kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => pid === -(child!.pid!) || realKill(pid, signal))

      abort.abort(reason)

      const failure = await Promise.resolve(child.wait()).then(() => undefined, (error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toEqual(expect.arrayContaining([
        reason,
        expect.objectContaining({ message: "[vitehub] Local harness process tree did not close after forced termination." }),
      ]))
      expect(localProcesses(session).size).toBe(1)

      kill.mockRestore()
      kill = undefined
      const closed = new Promise<void>(resolve => rawChild!.once("close", () => resolve()))
      realKill(-child.pid!, "SIGKILL")
      await closed
      await session.destroy?.()
      expect(localProcesses(session).size).toBe(0)
    }
    finally {
      kill?.mockRestore()
      if (child?.pid) {
        const closed = rawChild && rawChild.exitCode === null && rawChild.signalCode === null
          ? new Promise<void>(resolve => rawChild!.once("close", () => resolve()))
          : Promise.resolve()
        forceKillGroup(child.pid, realKill)
        await closed
      }
      await Promise.resolve(session.destroy?.()).catch(() => undefined)
    }
  })

  it.skipIf(process.platform === "win32")("coalesces concurrent process termination", async () => {
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH } })
    const session = await provider.createSession()
    const abort = new AbortController()
    const reason = new Error("client disconnected")
    let child: Awaited<ReturnType<typeof session.spawn>> | undefined
    let kill: ReturnType<typeof vi.spyOn> | undefined

    try {
      child = await spawnReady(session, abort.signal)
      const waiting = Promise.resolve(child.wait()).then(() => undefined, (error: unknown) => error)
      kill = vi.spyOn(process, "kill")

      const killed = child.kill()
      const stopped = session.stop()
      abort.abort(reason)

      await Promise.all([killed, stopped])
      await expect(waiting).resolves.toBe(reason)
      const signals = (kill!.mock.calls as [number, NodeJS.Signals?][])
        .filter(([pid]) => pid === -(child!.pid!))
        .map(([, signal]) => signal)
      expect(signals).toEqual(["SIGTERM", "SIGKILL"])
      expect(localProcesses(session).size).toBe(0)
    }
    finally {
      kill?.mockRestore()
      forceKillGroup(child?.pid)
      await session.destroy?.()
    }
  })

  it("does not spawn a command for an already-aborted signal", async () => {
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH } })
    const session = await provider.createSession()
    const abort = new AbortController()
    const reason = new Error("already cancelled")
    abort.abort(reason)

    try {
      await expect(session.spawn({
        abortSignal: abort.signal,
        command: "node -e \"setInterval(() => {}, 1000)\"",
      })).rejects.toBe(reason)
      expect(localProcesses(session).size).toBe(0)
    }
    finally {
      await session.destroy?.()
    }
  })

  it("rejects child process spawn errors", async () => {
    const session = await createLocalHarnessSandbox().createSession()

    try {
      await expect(session.run({
        command: "node -e \"\"",
        workingDirectory: "missing",
      })).rejects.toMatchObject({ code: "ENOENT" })
      expect(localProcesses(session).size).toBe(0)
    }
    finally {
      await session.destroy?.()
    }
  })

  it("settles after a command exits by signal", async () => {
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH } })
    const session = await provider.createSession()

    try {
      const child = await session.spawn({ command: "kill -TERM $$" })

      await expect(child.wait()).resolves.toEqual({ exitCode: 1 })
      expect(localProcesses(session).size).toBe(0)
    }
    finally {
      await session.destroy?.()
    }
  })

  it("does not wait for a second close when stop runs from the child close event", async () => {
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH } })
    const session = await provider.createSession()

    try {
      const child = await session.spawn({ command: "node -e \"\"" })
      const [{ child: rawChild }] = localProcesses(session)
      const stopped = new Promise<void>((resolve, reject) => {
        rawChild!.once("close", () => session.stop().then(resolve, reject))
      })

      await expect(child.wait()).resolves.toEqual({ exitCode: 0 })
      await expect(stopped).resolves.toBeUndefined()
      expect(localProcesses(session).size).toBe(0)
    }
    finally {
      await session.destroy?.()
    }
  })

  it("supports parallel bridge listeners across local providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-local-sandbox-"))
    const firstSession = await createLocalHarnessSandbox({ rootDir: root }).createSession()
    const secondSession = await createLocalHarnessSandbox({ rootDir: root }).createSession()
    let firstListener: Server | undefined
    let secondListener: Server | undefined

    try {
      firstListener = await listen(firstSession.ports[0]!)
      secondListener = await listen(secondSession.ports[0]!)

      expect(firstListener.address()).not.toEqual(secondListener.address())
    }
    finally {
      await Promise.all([close(firstListener), close(secondListener)])
      await Promise.all([firstSession.destroy?.(), secondSession.destroy?.()])
      await rm(root, { force: true, recursive: true })
    }
  })

  it("preserves explicit bridge port pools", async () => {
    const provider = createLocalHarnessSandbox({ ports: [4100, 4101] })
    const session = await provider.createSession()

    try {
      expect(provider.bridgePorts).toEqual([4100, 4101])
      expect(session.ports).toEqual([4100, 4101])
    }
    finally {
      await session.destroy?.()
    }
  })

  it("keeps absolute file paths inside the local sandbox root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-local-sandbox-"))
    const host = await mkdtemp(join(tmpdir(), "vitehub-host-"))
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH }, rootDir: root })
    const session = await provider.createSession()

    try {
      await session.writeTextFile({ content: "sandbox", path: `${host}/package.json` })

      await expect(stat(join(host, "package.json"))).rejects.toMatchObject({ code: "ENOENT" })
      await expect(readFile(join(root, host.replace(/^\/+/, ""), "package.json"), "utf8")).resolves.toBe("sandbox")
    }
    finally {
      await session.destroy?.()
      await rm(root, { force: true, recursive: true })
      await rm(host, { force: true, recursive: true })
    }
  })

  it("keeps Windows absolute file paths inside the local sandbox root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-local-sandbox-"))
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH }, rootDir: root })
    const session = await provider.createSession()

    try {
      await session.writeTextFile({ content: "sandbox", path: "C:\\repo\\package.json" })
      await session.writeTextFile({ content: "drive-relative", path: "D:repo\\nested.txt" })

      await expect(readFile(join(root, "repo", "package.json"), "utf8")).resolves.toBe("sandbox")
      await expect(readFile(join(root, "repo", "nested.txt"), "utf8")).resolves.toBe("drive-relative")
    }
    finally {
      await session.destroy?.()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects relative file paths outside the local sandbox root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-local-sandbox-"))
    const host = await mkdtemp(join(tmpdir(), "vitehub-host-"))
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH }, rootDir: root })
    const session = await provider.createSession()
    const hostFile = join(host, "package.json")

    try {
      await writeFile(hostFile, "host")

      await expect(session.writeTextFile({
        content: "sandbox",
        path: relative(root, hostFile),
      })).rejects.toThrow("escapes the session root")
      await expect(session.run({
        command: "pwd",
        workingDirectory: relative(root, host),
      })).rejects.toThrow("escapes the session root")
      await expect(readFile(hostFile, "utf8")).resolves.toBe("host")
    }
    finally {
      await session.destroy?.()
      await rm(root, { force: true, recursive: true })
      await rm(host, { force: true, recursive: true })
    }
  })

  it("runs Windows absolute working directories inside the local sandbox root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-local-sandbox-"))
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH }, rootDir: root })
    const session = await provider.createSession()

    try {
      await session.writeTextFile({ content: "ok", path: "C:\\repo\\input.txt" })
      const result = await session.run({
        command: "node -e \"console.log(process.cwd())\" && cat input.txt",
        workingDirectory: "C:\\repo",
      })

      expect(result.exitCode).toBe(0)
      const expectedCwd = join(root, "repo")
      expect(result.stdout.trim().split("\n")).toEqual([await realpath(expectedCwd), "ok"])
    }
    finally {
      await session.destroy?.()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("runs absolute working directories inside the local sandbox root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-local-sandbox-"))
    const host = await mkdtemp(join(tmpdir(), "vitehub-host-"))
    const provider = createLocalHarnessSandbox({
      env: {
        INIT_CWD: host,
        OLDPWD: host,
        PATH: process.env.PATH,
        PWD: host,
      },
      rootDir: root,
    })
    const session = await provider.createSession()
    const hostFile = join(host, "keep.txt")

    try {
      await writeFile(hostFile, "host")
      await session.writeTextFile({ content: "ok", path: `${host}/input.txt` })
      await session.writeTextFile({ content: "sandbox", path: `${host}/keep.txt` })
      const result = await session.run({
        command: "rm -f keep.txt; node -e \"console.log([process.cwd(), process.env.PWD, process.env.INIT_CWD].join('\\n'))\" && cat input.txt",
        workingDirectory: host,
      })

      expect(result.exitCode).toBe(0)
      const lines = result.stdout.trim().split("\n")
      const expectedCwd = join(root, host.replace(/^\/+/, ""))
      expect(lines.slice(0, 3)).toEqual([await realpath(expectedCwd), expectedCwd, expectedCwd])
      expect(lines).not.toContain(host)
      expect(lines).toContain("ok")
      await expect(readFile(hostFile, "utf8")).resolves.toBe("host")
    }
    finally {
      await session.destroy?.()
      await rm(root, { force: true, recursive: true })
      await rm(host, { force: true, recursive: true })
    }
  })
})

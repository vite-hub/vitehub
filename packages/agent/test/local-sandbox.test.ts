import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { describe, expect, it } from "vitest"

import { createLocalHarnessSandbox } from "../src/harness/local-sandbox.ts"

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

describe("local harness sandbox", () => {
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

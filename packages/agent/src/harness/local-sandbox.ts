import { spawn as spawnChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Readable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { createHash, randomUUID } from "node:crypto"
import { Cause, Effect, Exit } from "effect"
import { normalizeExecutionAuthority, type ExecutionAuthority } from "@vite-hub/runtime"

import { runAgentEffect, tryAgentPromise } from "../internal/effect-runtime.ts"

import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from "@ai-sdk/harness"

export interface LocalHarnessSandboxOptions {
  cleanup?: boolean
  env?: Record<string, string | undefined>
  ports?: readonly number[]
  rootDir?: string
}

interface LocalHarnessSandboxSession extends HarnessV1NetworkSandboxSession {
  [harnessRemoveDirectory](path: string): Promise<void>
  readonly cleanup: boolean
  readonly env: Record<string, string>
  readonly processes: Set<LocalProcessOwner>
  readonly rootDir: string
}

const harnessRemoveDirectory = Symbol.for("vitehub.harnessRemoveDirectory")

let localHarnessOwnerName: string | undefined
const localHarnessOwnerPattern = /^owner-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function getLocalHarnessOwnerName() {
  return localHarnessOwnerName ??= `owner-${process.pid}-${randomUUID()}`
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

async function managedRootDir(sessionId: string | undefined) {
  const parent = join(tmpdir(), "vitehub-harness")
  const owner = join(parent, getLocalHarnessOwnerName())
  await mkdir(owner, { recursive: true })

  const entries = await readdir(parent, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const match = localHarnessOwnerPattern.exec(entry.name)
    if (!match || isProcessAlive(Number(match[1]))) continue
    void rm(join(parent, entry.name), { force: true, recursive: true }).catch(() => undefined)
  }

  if (sessionId) return join(owner, createHash("sha256").update(sessionId).digest("hex"))
  return await mkdtemp(join(owner, "session-"))
}

async function defaultRootDir(sessionId: string | undefined, cleanup: boolean) {
  if (cleanup) {
    const root = await managedRootDir(sessionId)
    await mkdir(root, { recursive: true })
    return root
  }
  if (sessionId) {
    const root = join(tmpdir(), "vitehub-harness", createHash("sha256").update(sessionId).digest("hex"))
    await mkdir(root, { recursive: true })
    return root
  }
  return await mkdtemp(join(tmpdir(), "vitehub-harness-"))
}

function isInside(root: string, path: string) {
  const next = relative(root, path)
  return !next || (!next.startsWith("..") && !isAbsolute(next))
}

function isRootedPath(path: string) {
  return isAbsolute(path) || /^[A-Za-z]:/.test(path) || /^[\\/]{2}/.test(path)
}

function rootRelativeFragment(path: string) {
  return path
    .replace(/^[A-Za-z]:[\\/]*/, "")
    .replace(/^[\\/]+/, "")
    .replace(/\\/g, "/")
}

function resolvePath(session: LocalHarnessSandboxSession, path = "") {
  const root = resolve(session.rootDir)
  const candidate = isRootedPath(path)
    ? isAbsolute(path) && isInside(root, resolve(path))
      ? resolve(path)
      : resolve(root, rootRelativeFragment(path))
    : resolve(session.defaultWorkingDirectory, path)

  if (!isInside(root, candidate)) {
    throw new Error(`[vitehub] Local harness sandbox path escapes the session root: ${path}`)
  }
  return candidate
}

class LocalProcessOwner {
  readonly closed: Promise<void>
  #didClose = false
  #termination?: Promise<void>

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.closed = new Promise((resolve, reject) => {
      child.once("error", (error) => {
        this.#didClose = true
        reject(error)
      })
      child.once("close", () => {
        this.#didClose = true
        resolve()
      })
    })
  }

  async #signal(signal: NodeJS.Signals) {
    const pid = this.child.pid
    if (!pid) throw new Error("[vitehub] Local harness process has no process id.")
    if (process.platform === "win32") {
      try {
        const killer = spawnChildProcess("taskkill.exe", ["/pid", String(pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])], {
          stdio: "ignore",
          windowsHide: true,
        })
        const [code] = await once(killer, "close")
        if (code !== 0) throw new Error(`[vitehub] Windows process tree termination failed with exit code ${code}.`)
      }
      catch (error) {
        if (!this.#didClose) throw error
      }
      return
    }
    try {
      process.kill(-pid, signal)
    }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
    }
  }

  async #wait(timeout: number) {
    if (this.#didClose) return true
    return await Promise.race([
      this.closed.then(() => true),
      delay(timeout, false, { ref: false }),
    ])
  }

  async #terminate() {
    const terminated = this.#wait(250)
    await this.#signal("SIGTERM")
    if (await terminated) return
    const killed = this.#wait(1_000)
    await this.#signal("SIGKILL")
    if (!await killed) throw new Error("[vitehub] Local harness process tree did not close after forced termination.")
  }

  terminate() {
    if (this.#didClose) return Promise.resolve()
    return this.#termination ??= this.#terminate().finally(() => {
      this.#termination = undefined
    })
  }
}

function waitForProcess(session: LocalHarnessSandboxSession, owner: LocalProcessOwner, abortSignal?: AbortSignal) {
  return runAgentEffect(Effect.acquireUseRelease(
    Effect.succeed(owner),
    process => tryAgentPromise(async () => {
      await process.closed
      return { exitCode: typeof process.child.exitCode === "number" ? process.child.exitCode : 1 }
    }),
    (process, useExit) => Effect.matchCauseEffect(
      tryAgentPromise(async () => {
        await process.terminate()
        session.processes.delete(process)
      }),
      {
        onFailure: cleanupCause => Effect.failCause(
          Exit.isFailure(useExit) ? Cause.combine(useExit.cause, cleanupCause) : cleanupCause,
        ),
        onSuccess: () => Effect.void,
      },
    ),
  ), abortSignal ? { signal: abortSignal } : undefined)
}

function readableStreamFromBytes(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function bytesFromReadableStream(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function spawnProcess(session: LocalHarnessSandboxSession, options: {
  abortSignal?: AbortSignal
  command: string
  env?: Record<string, string>
  workingDirectory?: string
}) {
  options.abortSignal?.throwIfAborted()
  const cwd = resolvePath(session, options.workingDirectory)
  const child = spawnChildProcess(options.command, {
    cwd,
    detached: process.platform !== "win32",
    env: { ...session.env, ...options.env, INIT_CWD: cwd, OLDPWD: cwd, PWD: cwd },
    shell: true,
  })
  const owner = new LocalProcessOwner(child)
  session.processes.add(owner)
  const wait = waitForProcess(session, owner, options.abortSignal)

  return {
    pid: child.pid,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    wait: () => wait,
    kill: async () => {
      await owner.terminate()
      await wait.catch(() => undefined)
    },
  }
}

async function collect(stream: ReadableStream<Uint8Array>) {
  return new TextDecoder().decode(await bytesFromReadableStream(stream))
}

async function createSession(options: LocalHarnessSandboxOptions, sessionId: string | undefined): Promise<LocalHarnessSandboxSession> {
  const cleanup = options.cleanup ?? !options.rootDir
  const rootDir = options.rootDir || await defaultRootDir(sessionId, cleanup)
  await mkdir(rootDir, { recursive: true })
  const env = { ...stringEnv(options.env || process.env), INIT_CWD: rootDir, OLDPWD: rootDir, PWD: rootDir }
  const session = {
    async [harnessRemoveDirectory](path: string) {
      const directory = resolvePath(this, path)
      await rm(directory, { force: true, recursive: true })
      for (const parent of [dirname(directory), dirname(dirname(directory))]) {
        await rmdir(parent).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error
        })
      }
    },
    cleanup,
    defaultWorkingDirectory: rootDir,
    description: "Workspace shell.",
    env,
    id: sessionId || randomUUID(),
    ports: options.ports || [0],
    processes: new Set<LocalProcessOwner>(),
    rootDir,
    async destroy() {
      await this.stop()
      if (this.cleanup) await rm(this.rootDir, { force: true, recursive: true })
    },
    async getPortUrl({ port, protocol = "http" }: { port: number, protocol?: "http" | "https" | "ws" }) {
      return `${protocol}://127.0.0.1:${port}`
    },
    async readBinaryFile({ path }: { path: string }) {
      return await readFile(resolvePath(this, path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      })
    },
    async readFile({ path }: { path: string }) {
      const bytes = await this.readBinaryFile({ path })
      return bytes ? readableStreamFromBytes(bytes) : null
    },
    async readTextFile({ encoding = "utf8", endLine, path, startLine }: { encoding?: string, endLine?: number, path: string, startLine?: number }) {
      const bytes = await this.readBinaryFile({ path })
      if (!bytes) return null
      const text = Buffer.from(bytes).toString(encoding as BufferEncoding)
      if (startLine === undefined && endLine === undefined) return text
      return text.split(/\r?\n/).slice((startLine || 1) - 1, endLine).join("\n")
    },
    restricted() {
      return this
    },
    async run(runOptions: { abortSignal?: AbortSignal, command: string, env?: Record<string, string>, workingDirectory?: string }) {
      const child = await this.spawn(runOptions)
      const [stdout, stderr, { exitCode }] = await Promise.all([
        collect(child.stdout),
        collect(child.stderr),
        child.wait(),
      ])
      return { exitCode, stderr, stdout }
    },
    async spawn(spawnOptions: { abortSignal?: AbortSignal, command: string, env?: Record<string, string>, workingDirectory?: string }) {
      return spawnProcess(this, spawnOptions)
    },
    async stop() {
      await Promise.all(Array.from(this.processes, async (owner) => {
        await owner.terminate()
        this.processes.delete(owner)
      }))
    },
    async writeBinaryFile({ content, path }: { content: Uint8Array, path: string }) {
      const resolved = resolvePath(this, path)
      await mkdir(dirname(resolved), { recursive: true })
      await writeFile(resolved, content)
    },
    async writeFile({ content, path }: { content: ReadableStream<Uint8Array>, path: string }) {
      await this.writeBinaryFile({ content: await bytesFromReadableStream(content), path })
    },
    async writeTextFile({ content, encoding = "utf8", path }: { content: string, encoding?: string, path: string }) {
      await this.writeBinaryFile({ content: Buffer.from(content, encoding as BufferEncoding), path })
    },
  } satisfies LocalHarnessSandboxSession
  return session
}

export function createLocalHarnessSandbox(
  options: LocalHarnessSandboxOptions = {},
): HarnessV1SandboxProvider & { readonly executionAuthority: ExecutionAuthority } {
  return createLocalHarnessSandboxProvider(options)
}

function createLocalHarnessSandboxProvider(
  options: LocalHarnessSandboxOptions,
): HarnessV1SandboxProvider & { readonly executionAuthority: ExecutionAuthority } {
  const firstCreates = new Map<string, Promise<void>>()

  return {
    ...(options.ports ? { bridgePorts: options.ports } : {}),
    executionAuthority: normalizeExecutionAuthority({
      credentials: options.env === undefined ? "ambient" : "unknown",
      environment: options.env === undefined ? "ambient" : "selected",
      filesystem: { access: "read-write", scope: "host" },
      isolation: "none",
      network: "unrestricted",
      processes: "arbitrary",
    }),
    providerId: "local",
    specificationVersion: "harness-sandbox-v1",
    async createSession(createOptions) {
      const onFirstCreate = createOptions?.onFirstCreate
      if (!onFirstCreate) return await createSession(options, createOptions?.sessionId)
      const key = options.rootDir ? "root" : createOptions?.sessionId
      if (!key) {
        const session = await createSession(options, createOptions?.sessionId)
        await onFirstCreate(session, { abortSignal: createOptions.abortSignal })
        return session
      }

      const previous = firstCreates.get(key) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>(resolve => release = resolve)
      firstCreates.set(key, current)
      await previous
      try {
        const session = await createSession(options, createOptions?.sessionId)
        await onFirstCreate(session, { abortSignal: createOptions.abortSignal })
        return session
      }
      finally {
        release()
        if (firstCreates.get(key) === current) firstCreates.delete(key)
      }
    },
    async resumeSession(resumeOptions) {
      return await createSession(options, resumeOptions.sessionId)
    },
  }
}

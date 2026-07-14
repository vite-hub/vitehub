import { spawn as spawnChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Readable } from "node:stream"
import { randomUUID } from "node:crypto"

import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from "@ai-sdk/harness"

export interface LocalHarnessSandboxOptions {
  cleanup?: boolean
  env?: Record<string, string | undefined>
  ports?: readonly number[]
  rootDir?: string
}

export interface TrustedHostHarnessSandboxOptions {
  env: Record<string, string | undefined>
  workspaceDir?: string
}

interface LocalHarnessSandboxProviderOptions extends LocalHarnessSandboxOptions {
  workspaceDir?: string
}

interface LocalHarnessSandboxSession extends HarnessV1NetworkSandboxSession {
  readonly cleanup: boolean
  readonly env: Record<string, string>
  readonly physicalWorkingDirectory: boolean
  readonly processes: Set<ChildProcessWithoutNullStreams>
  readonly rootDir: string
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

async function defaultRootDir(sessionId: string | undefined) {
  if (sessionId) {
    const root = join(tmpdir(), "vitehub-harness", sessionId)
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
  const cwd = resolvePath(session, options.workingDirectory)
  const physicalCwd = session.physicalWorkingDirectory ? realpathSync(cwd) : cwd
  const child = spawnChildProcess(options.command, {
    cwd: physicalCwd,
    env: { ...session.env, ...options.env, INIT_CWD: physicalCwd, OLDPWD: physicalCwd, PWD: physicalCwd },
    shell: true,
  })
  session.processes.add(child)

  let abortReason: unknown
  const abort = () => {
    abortReason = options.abortSignal?.reason || new Error("Sandbox command aborted.")
    child.kill()
  }
  options.abortSignal?.addEventListener("abort", abort, { once: true })

  const wait = new Promise<{ exitCode: number }>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => {
      session.processes.delete(child)
      options.abortSignal?.removeEventListener("abort", abort)
      if (abortReason) {
        reject(abortReason)
        return
      }
      resolve({ exitCode: code ?? 1 })
    })
  })

  return {
    pid: child.pid,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    wait: () => wait,
    kill: async () => {
      child.kill()
      await wait.catch(() => undefined)
    },
  }
}

async function collect(stream: ReadableStream<Uint8Array>) {
  return new TextDecoder().decode(await bytesFromReadableStream(stream))
}

async function createSession(options: LocalHarnessSandboxProviderOptions, sessionId: string | undefined): Promise<LocalHarnessSandboxSession> {
  const rootDir = options.rootDir || await defaultRootDir(sessionId)
  await mkdir(rootDir, { recursive: true })
  if (options.workspaceDir) await bindWorkspace(rootDir, options.workspaceDir)
  const env = { ...stringEnv(options.env || process.env), INIT_CWD: rootDir, OLDPWD: rootDir, PWD: rootDir }
  const session = {
    cleanup: options.cleanup ?? !options.rootDir,
    defaultWorkingDirectory: rootDir,
    description: "Workspace shell.",
    env,
    id: sessionId || randomUUID(),
    ports: options.ports || [0],
    physicalWorkingDirectory: Boolean(options.workspaceDir),
    processes: new Set<ChildProcessWithoutNullStreams>(),
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
      await Promise.all(Array.from(this.processes, child => new Promise<void>((resolve) => {
        child.once("close", () => resolve())
        child.kill()
      })))
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

async function bindWorkspace(rootDir: string, workspaceDir: string): Promise<void> {
  const link = join(rootDir, "workspace")
  try {
    await symlink(workspaceDir, link, "dir")
  }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
    if (await realpath(link) !== await realpath(workspaceDir)) throw error
  }
}

export function createLocalHarnessSandbox(options: LocalHarnessSandboxOptions = {}): HarnessV1SandboxProvider {
  return createLocalHarnessSandboxProvider(options)
}

export function createTrustedHostHarnessSandbox(options: TrustedHostHarnessSandboxOptions): HarnessV1SandboxProvider {
  return createLocalHarnessSandboxProvider({
    cleanup: true,
    env: options.env,
    workspaceDir: options.workspaceDir,
  })
}

function createLocalHarnessSandboxProvider(options: LocalHarnessSandboxProviderOptions): HarnessV1SandboxProvider {
  const firstCreates = new Map<string, Promise<void>>()

  return {
    ...(options.ports ? { bridgePorts: options.ports } : {}),
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
  }
}

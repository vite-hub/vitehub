import { posix } from "node:path"

import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from "@ai-sdk/harness"
import type { Box, BoxProcess, BoxSession } from "@vite-hub/box"
import type { ExecutionAuthority } from "@vite-hub/runtime"
import type { WorkspaceSessionHost } from "@vite-hub/workspace"
import { openHarnessBox } from "./shared-box.ts"

const harnessRemoveDirectory = Symbol.for("vitehub.harnessRemoveDirectory")

type BoxHarnessSandboxSession = HarnessV1NetworkSandboxSession & {
  [harnessRemoveDirectory](path: string): Promise<void>
  workspaceHost: WorkspaceSessionHost
}

function streamFromBytes(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function bytesFromStream(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function resolvePath(session: BoxSession, path: string) {
  return path.startsWith("/") ? posix.normalize(path) : posix.resolve(session.cwd, path)
}

function adaptProcess(process: BoxProcess) {
  return {
    pid: process.pid,
    stderr: process.stderr,
    stdout: process.stdout,
    async kill(signal?: string) {
      await process.kill(signal)
    },
    async wait() {
      const result = await process.wait()
      return { exitCode: result.code }
    },
  }
}

function adaptBoxSession(session: BoxSession, preparationSignal?: AbortSignal): BoxHarnessSandboxSession {
  if (!session.spawn) throw new Error("[vitehub] Harness Agent Drivers require a Box runtime with process spawning.")
  let workspaceSignal = preparationSignal
  const workspaceHost: WorkspaceSessionHost = {
    detachAbortSignal() {
      workspaceSignal = undefined
    },
    executionAuthority: session.executionAuthority,
    files: {
      exists: async path => await session.files.exists(path, { signal: workspaceSignal }),
      list: async (path, options) => await session.files.list(path, { ...options, signal: workspaceSignal }),
      mkdir: async (path, options) => await session.files.mkdir(path, { ...options, signal: workspaceSignal }),
      read: async path => await session.files.read(path, { signal: workspaceSignal }),
      remove: async (path, options) => await session.files.remove(path, { ...options, signal: workspaceSignal }),
      write: async (path, content) => await session.files.write(path, content, { signal: workspaceSignal }),
    },
    exec: async (command, args, options) => await session.exec(command, args, {
      ...options,
      signal: options?.signal || workspaceSignal,
    }),
  }
  const adapted = {
    async [harnessRemoveDirectory](path: string) {
      const directory = resolvePath(session, path)
      await session.files.remove(directory, { recursive: true })
      for (const parent of [posix.dirname(directory), posix.dirname(posix.dirname(directory))]) {
        if (await session.files.list(parent).then(entries => entries.length > 0).catch(() => true)) break
        await session.files.remove(parent)
      }
    },
    defaultWorkingDirectory: session.cwd,
    description: `ViteHub Box ${session.id}`,
    id: session.id,
    ports: session.ports?.values || [],
    async destroy() {
      await session.close()
    },
    async getPortUrl({ port, protocol = "http" }: { port: number, protocol?: "http" | "https" | "ws" }) {
      if (!session.ports) throw new Error(`[vitehub] Box runtime does not expose ports.`)
      return String(await session.ports.expose(port, { protocol }))
    },
    async readBinaryFile({ path }: { path: string }) {
      return await session.files.read(resolvePath(session, path))
    },
    async readFile({ path }: { path: string }) {
      const bytes = await this.readBinaryFile({ path })
      return bytes ? streamFromBytes(bytes) : null
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
    workspaceHost,
    async run({ abortSignal, command, env, workingDirectory }: { abortSignal?: AbortSignal, command: string, env?: Record<string, string>, workingDirectory?: string }) {
      const result = await session.exec("sh", ["-lc", command], {
        cwd: resolvePath(session, workingDirectory || session.cwd),
        env,
        signal: abortSignal,
      })
      return { exitCode: result.code, stderr: result.stderr, stdout: result.stdout }
    },
    async spawn({ abortSignal, command, env, workingDirectory }: { abortSignal?: AbortSignal, command: string, env?: Record<string, string>, workingDirectory?: string }) {
      return adaptProcess(await session.spawn!("sh", ["-lc", command], {
        cwd: resolvePath(session, workingDirectory || session.cwd),
        env,
        signal: abortSignal,
      }))
    },
    async stop() {
      await session.close()
    },
    async writeBinaryFile({ content, path }: { content: Uint8Array, path: string }) {
      const target = resolvePath(session, path)
      await session.files.mkdir(posix.dirname(target), { recursive: true })
      await session.files.write(target, content)
    },
    async writeFile({ content, path }: { content: ReadableStream<Uint8Array>, path: string }) {
      await this.writeBinaryFile({ content: await bytesFromStream(content), path })
    },
    async writeTextFile({ content, encoding = "utf8", path }: { content: string, encoding?: string, path: string }) {
      await this.writeBinaryFile({ content: Buffer.from(content, encoding as BufferEncoding), path })
    },
  } satisfies BoxHarnessSandboxSession
  return adapted
}

async function openInvocationBox(box: Box, options: Parameters<typeof openHarnessBox>[1], signal?: AbortSignal) {
  const opening = openHarnessBox(box, options)
  if (!signal) return await opening
  signal.throwIfAborted()
  return await new Promise<BoxSession>((resolve, reject) => {
    const aborted = () => {
      opening.then(session => session.close()).catch(() => undefined)
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"))
    }
    signal.addEventListener("abort", aborted, { once: true })
    if (signal.aborted) aborted()
    opening.then(
      (session) => {
        signal.removeEventListener("abort", aborted)
        resolve(session)
      },
      (error) => {
        signal.removeEventListener("abort", aborted)
        reject(error)
      },
    )
  })
}

export function createBoxHarnessSandbox(
  box: Box,
): HarnessV1SandboxProvider & { readonly executionAuthority: ExecutionAuthority } {
  return {
    executionAuthority: box.plan.executionAuthority,
    providerId: box.plan.runtime,
    specificationVersion: "harness-sandbox-v1",
    async createSession(options) {
      options?.abortSignal?.throwIfAborted()
      let adapted: HarnessV1NetworkSandboxSession | undefined
      const session = await openInvocationBox(box, {
        id: options?.sessionId,
        initialize: options?.onFirstCreate
          ? async (boxSession) => {
              adapted = adaptBoxSession(boxSession, options.abortSignal)
              await options.onFirstCreate!(adapted, { abortSignal: options.abortSignal })
            }
          : undefined,
      }, options?.abortSignal)
      try {
        options?.abortSignal?.throwIfAborted()
        return adapted || adaptBoxSession(session, options?.abortSignal)
      }
      catch (error) {
        await session.close().catch(() => undefined)
        throw error
      }
    },
    async resumeSession(options) {
      options.abortSignal?.throwIfAborted()
      const session = await openInvocationBox(box, { id: options.sessionId }, options.abortSignal)
      try {
        options.abortSignal?.throwIfAborted()
        return adaptBoxSession(session, options.abortSignal)
      }
      catch (error) {
        await session.close().catch(() => undefined)
        throw error
      }
    },
  }
}

import { posix } from "node:path"

import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from "@ai-sdk/harness"
import type { Box, BoxProcess, BoxSession } from "@vite-hub/box"
import { openHarnessBox } from "./shared-box.ts"

export const boxHarnessWorkDir = "workspace"

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
  const resolved = path.startsWith("/") ? posix.normalize(path) : posix.resolve(session.cwd, path)
  const harnessWorkspace = posix.join(posix.dirname(session.cwd), boxHarnessWorkDir)
  if (resolved === harnessWorkspace) return session.cwd
  if (resolved.startsWith(`${harnessWorkspace}/`)) {
    return posix.join(session.cwd, resolved.slice(harnessWorkspace.length + 1))
  }
  return resolved
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

function adaptBoxSession(session: BoxSession): HarnessV1NetworkSandboxSession {
  if (!session.spawn) throw new Error("[vitehub] Harness Agent Drivers require a Box runtime with process spawning.")
  const adapted = {
    defaultWorkingDirectory: posix.dirname(session.cwd),
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
  } satisfies HarnessV1NetworkSandboxSession
  return adapted
}

async function adaptOrClose(session: BoxSession) {
  try {
    return adaptBoxSession(session)
  }
  catch (error) {
    await session.close().catch(() => undefined)
    throw error
  }
}

export function createBoxHarnessSandbox(box: Box): HarnessV1SandboxProvider {
  return {
    providerId: box.plan.runtime,
    specificationVersion: "harness-sandbox-v1",
    async createSession(options) {
      let adapted: HarnessV1NetworkSandboxSession | undefined
      const session = await openHarnessBox(box, {
        id: options?.sessionId,
        signal: options?.abortSignal,
        initialize: options?.onFirstCreate
          ? async (boxSession, { signal }) => {
              adapted = adaptBoxSession(boxSession)
              await options.onFirstCreate!(adapted, { abortSignal: signal })
            }
          : undefined,
      })
      return adapted || await adaptOrClose(session)
    },
    async resumeSession(options) {
      return await adaptOrClose(await openHarnessBox(box, { id: options.sessionId, signal: options.abortSignal }))
    },
  }
}

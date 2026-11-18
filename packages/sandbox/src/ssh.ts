import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { promisify } from "node:util"
import type { ChildProcess } from "node:child_process"
import type { Socket } from "node:net"
import type { Connection } from "ssh2"

import { invariant } from "@vite-hub/internal/invariant"
import { stopMarkedProcesses } from "@vite-hub/internal/process-sweep"

import { sandboxErrorDiagnostics } from "./error-diagnostics.ts"
import { launcherSource } from "./ssh-launcher.injected.ts"

const maxTimeoutMs = 2_147_483_647

export interface SshLaunchOptions {
  host: string
  user: string
  identityFile: string
  port?: number
  /** A known_hosts file. The normal OpenSSH host verification applies when omitted. */
  knownHostsFile?: string
  /** A trusted SSH public host key, for a sidecar whose keys share a volume. */
  hostKeyFile?: string
  /** Environment names only. Defaults to the launch context environment and required names. Values travel through SSH env requests. */
  forwardEnvironment?: readonly string[]
  /**
   * How long, in milliseconds, to connect again while the SSH port refuses connections, for example while a sidecar
   * starts. Other SSH failures are not retried. Defaults to 30000. Set 0 to fail on the first refused connection.
   */
  connectRetryMs?: number
}

export interface SshLaunchContext {
  command: string
  cwd: string
  environment?: Readonly<Record<string, string | undefined>>
  requiredEnvironment?: readonly string[]
}

const environmentName = /^[A-Z_][A-Z0-9_]*$/
/** Every process of one SSH command starts with this variable, so the server can stop the ones that leave its process group. */
const commandEnvironmentKey = "VITEHUB_SSH_COMMAND"

/** Launch a command on a trusted SSH host with the same working-directory path. */
export function sshLaunch(options: SshLaunchOptions): (context: SshLaunchContext) => { command: string; args: string[]; prepare: (context: { abortSignal?: AbortSignal }) => Promise<void> } {
  if (!options.host || options.host.startsWith("-") || /[\s\0]/.test(options.host)) throw sandboxErrorDiagnostics.SANDBOX_SSH_LAUNCH_INVALID({ problem: "host" })
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(options.user)) throw sandboxErrorDiagnostics.SANDBOX_SSH_LAUNCH_INVALID({ problem: "user" })
  if (!options.identityFile || options.identityFile.includes("\0")) throw sandboxErrorDiagnostics.SANDBOX_SSH_LAUNCH_INVALID({ problem: "identityFile" })
  const port = options.port ?? 22
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw sandboxErrorDiagnostics.SANDBOX_SSH_LAUNCH_INVALID({ problem: "port" })
  if (options.hostKeyFile && options.knownHostsFile) throw sandboxErrorDiagnostics.SANDBOX_SSH_LAUNCH_INVALID({ problem: "hostKey" })
  const connectRetryMs = options.connectRetryMs ?? 30_000
  if (!Number.isSafeInteger(connectRetryMs) || connectRetryMs < 0) throw sandboxErrorDiagnostics.SANDBOX_SSH_LAUNCH_INVALID({ problem: "connectRetryMs" })
  const forwardEnvironment = [...new Set(options.forwardEnvironment ?? [])]
  if (forwardEnvironment.some(name => !environmentName.test(name))) throw sandboxErrorDiagnostics.SANDBOX_SSH_LAUNCH_INVALID({ problem: "environment" })
  return ({ command, cwd, environment, requiredEnvironment }: SshLaunchContext) => {
    const names = options.forwardEnvironment === undefined ? Object.keys(environment || {}).filter(name => environmentName.test(name)) : forwardEnvironment
    const forwarded = [...new Set([...names, ...(requiredEnvironment || [])])]
    if (forwarded.some(name => !environmentName.test(name))) throw sandboxErrorDiagnostics.SANDBOX_SSH_LAUNCH_INVALID({ problem: "environment" })
    if (!command || !cwd || command.includes("\0") || cwd.includes("\0")) throw sandboxErrorDiagnostics.SANDBOX_SSH_LAUNCH_INVALID({ problem: "command" })
    const args = (command: string, cwd: string) => ["--input-type=module", "-e", launcherSource, JSON.stringify({ ...options, port, connectRetryMs, forwardEnvironment: forwarded, command, cwd })]
    return {
      command: process.execPath,
      args: args(command, cwd),
      // Agent inspection calls this before the provider starts its own short status-probe deadline.
      prepare: async ({ abortSignal }) => {
        await promisify(execFile)(process.execPath, args("/bin/true", "/"), { signal: abortSignal })
      },
    }
  }
}

export interface SshServerOptions {
  hostKeyFile: string
  authorizedKeyFile: string
  user: string
  cwd: string
  port?: number
  host?: string
  /** Restrict accepted env names. Omit to accept valid names from the trusted client. */
  acceptEnvironment?: readonly string[]
}

export interface SshServerCloseOptions {
  /**
   * Wait up to this many milliseconds for open connections to close before the server ends them and their commands.
   * Defaults to 0, which ends them at once.
   */
  drainTimeoutMs?: number
}

export interface SshServer {
  port: number
  /** Open client connections, including connections that have not finished authentication. */
  readonly connections: number
  /**
   * Stops accepting connections at once, then ends open connections and stops their commands. Clients that are
   * already connected can still run commands while `drainTimeoutMs` lasts. Another call without `drainTimeoutMs`
   * ends the wait early. All calls return the same promise.
   */
  close(options?: SshServerCloseOptions): Promise<void>
}

/** An authenticated command server, not a filesystem or network sandbox. */
export async function serveSsh(options: SshServerOptions): Promise<SshServer> {
  if (process.platform === "win32") throw sandboxErrorDiagnostics.SANDBOX_SSH_POSIX_REQUIRED()
  const { default: ssh2 } = await import("ssh2")
  const [hostKey, authorizedKey] = await Promise.all([readFile(options.hostKeyFile), readFile(options.authorizedKeyFile)])
  const parsedKey = ssh2.utils.parseKey(authorizedKey)
  if (parsedKey instanceof Error) throw parsedKey
  const publicKey = Array.isArray(parsedKey) ? parsedKey[0]! : parsedKey
  const clients = new Set<Connection>()
  const sockets = new Set<Socket>()
  const children = new Set<ChildProcess>()
  const markers = new Map<ChildProcess, string>()
  const terminations = new Map<ChildProcess, Promise<void>>()
  const allowed = options.acceptEnvironment && new Set(options.acceptEnvironment)
  function stop(child: ChildProcess) {
    const pending = terminations.get(child)
    if (pending) return pending
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try { process.kill(-child.pid, signal) }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error
      }
    }
    const done = (async () => {
      signalGroup("SIGTERM")
      await new Promise(resolve => setTimeout(resolve, 250))
      signalGroup("SIGKILL")
      const marker = markers.get(child)
      if (marker) await stopMarkedProcesses(commandEnvironmentKey, marker)
    })()
    terminations.set(child, done)
    return done
  }
  const server = new ssh2.Server({ hostKeys: [hostKey] }, client => {
    clients.add(client)
    client.once("close", () => clients.delete(client))
    // Protocol errors close this connection. Do not log client-supplied command text.
    client.on("error", () => client.end())
    client.on("authentication", context => {
      if (context.method !== "publickey" || context.username !== options.user || !context.key.data.equals(publicKey.getPublicSSH())) return context.reject(["publickey"])
      if (!context.signature || publicKey.verify(context.blob!, context.signature, context.hashAlgo) === true) return context.accept()
      context.reject(["publickey"])
    })
    client.on("ready", () => client.on("session", accept => {
      const session = accept()
      const environment: Record<string, string> = Object.create(null)
      session.on("env", (acceptEnv, rejectEnv, info) => {
        if (!environmentName.test(info.key) || allowed && !allowed.has(info.key)) return rejectEnv?.()
        environment[info.key] = info.val
        acceptEnv?.()
      })
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec()
        stream.allowHalfOpen = true
        const marker = randomUUID()
        // Not a login shell: a profile, such as Debian's /etc/profile, would set PATH again and drop the forwarded one.
        const child = spawn("/bin/sh", ["-c", info.command], {
          cwd: options.cwd,
          detached: true,
          env: { ...process.env, ...environment, [commandEnvironmentKey]: marker },
          stdio: ["pipe", "pipe", "pipe"],
        })
        children.add(child)
        markers.set(child, marker)
        stream.pipe(child.stdin)
        child.stdin.on("error", () => {}) // Remote command can close stdin before the SSH peer does.
        child.stdout.pipe(stream, { end: false })
        child.stderr.pipe(stream.stderr, { end: false })
        const terminate = () => { void stop(child).catch(() => client.end()) }
        stream.once("close", terminate)
        stream.on("error", terminate)
        child.once("exit", terminate)
        child.once("error", () => { stream.exit(127); stream.end() })
        child.once("close", code => {
          void stop(child).finally(() => { children.delete(child); markers.delete(child); terminations.delete(child) })
          stream.exit(code ?? 1)
          stream.end()
        })
      })
    }))
  })
  // Track sockets before SSH identification, so incomplete handshakes cannot hold shutdown open.
  let endDrain: (() => void) | undefined
  const listener = createServer(socket => {
    sockets.add(socket)
    socket.once("close", () => {
      sockets.delete(socket)
      if (!sockets.size) endDrain?.()
    })
    server.injectSocket(socket)
  })
  const listening = once(listener, "listening")
  listener.listen(options.port ?? 2222, options.host ?? "127.0.0.1")
  await listening
  const address = listener.address()
  invariant(address && address instanceof Object, "an SSH listener on a TCP host and port has a TCP address")
  let closing: Promise<void> | undefined
  return {
    port: address.port,
    get connections() {
      return sockets.size
    },
    close({ drainTimeoutMs = 0 } = {}) {
      if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 0 || drainTimeoutMs > maxTimeoutMs) throw sandboxErrorDiagnostics.SANDBOX_SSH_DRAIN_TIMEOUT_INVALID()
      if (closing) {
        if (!drainTimeoutMs) endDrain?.()
        return closing
      }
      return closing = (async () => {
        const closed = new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
        if (drainTimeoutMs && sockets.size) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => endDrain?.(), drainTimeoutMs)
            endDrain = () => {
              clearTimeout(timer)
              endDrain = undefined
              resolve()
            }
          })
        }
        for (const client of clients) client.end()
        await Promise.all([...children].map(stop))
        for (const socket of sockets) socket.destroy()
        await closed
      })()
    },
  }
}

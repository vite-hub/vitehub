import { spawn } from "node:child_process"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { createServer } from "node:net"
import type { ChildProcess } from "node:child_process"
import type { Socket } from "node:net"
import type { Connection } from "ssh2"

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
}

export interface SshLaunchContext {
  command: string
  cwd: string
  environment?: Readonly<Record<string, string | undefined>>
  requiredEnvironment?: readonly string[]
}

const environmentName = /^[A-Z_][A-Z0-9_]*$/

// The launcher runs outside the application bundle. It needs only Node and OpenSSH.
const launcherSource = String.raw`
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const config = JSON.parse(process.argv[1])
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
let temporary
try {
  let knownHostsFile = config.knownHostsFile
  if (config.hostKeyFile) {
    temporary = await mkdtemp(join(tmpdir(), "vitehub-ssh-"))
    knownHostsFile = join(temporary, "known_hosts")
    const key = (await readFile(config.hostKeyFile, "utf8")).trim()
    if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+(?: .*)?$/.test(key)) throw new Error("Invalid SSH host public key")
    await writeFile(knownHostsFile, "vitehub-runner " + key + "\n", { mode: 0o600 })
  }
  const child = spawn("ssh", [
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "LogLevel=ERROR", "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=yes",
    ...(knownHostsFile ? ["-o", "UserKnownHostsFile=" + knownHostsFile] : []),
    ...(config.hostKeyFile ? ["-o", "HostKeyAlias=vitehub-runner"] : []),
    "-i", config.identityFile, "-p", String(config.port),
    ...config.forwardEnvironment.flatMap(name => ["-o", "SendEnv=" + name]),
    config.user + "@" + config.host,
    "cd " + quote(config.cwd) + " && exec " + [config.command, ...process.argv.slice(2)].map(quote).join(" "),
  ], { stdio: "inherit" })
  const handlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => child.kill(signal)]))
  for (const [signal, handler] of handlers) process.on(signal, handler)
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    process.exitCode = result.code ?? 1
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true })
}
`

/** Launch a command on a trusted SSH host with the same working-directory path. */
export function sshLaunch(options: SshLaunchOptions): (context: SshLaunchContext) => { command: string; args: string[] } {
  if (!options.host || options.host.startsWith("-") || /[\s\0]/.test(options.host)) throw new TypeError("[vitehub] SSH host is invalid.")
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(options.user)) throw new TypeError("[vitehub] SSH user is invalid.")
  if (!options.identityFile || options.identityFile.includes("\0")) throw new TypeError("[vitehub] SSH identityFile is required.")
  const port = options.port ?? 22
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("[vitehub] SSH port must be between 1 and 65535.")
  if (options.hostKeyFile && options.knownHostsFile) throw new TypeError("[vitehub] Select hostKeyFile or knownHostsFile.")
  const forwardEnvironment = [...new Set(options.forwardEnvironment ?? [])]
  if (forwardEnvironment.some(name => !environmentName.test(name))) throw new TypeError("[vitehub] SSH environment names must be uppercase shell identifiers.")
  return ({ command, cwd, environment, requiredEnvironment }: SshLaunchContext) => {
    const names = options.forwardEnvironment === undefined ? Object.keys(environment || {}).filter(name => environmentName.test(name)) : forwardEnvironment
    const forwarded = [...new Set([...names, ...(requiredEnvironment || [])])]
    if (forwarded.some(name => !environmentName.test(name))) throw new TypeError("[vitehub] SSH environment names must be uppercase shell identifiers.")
    if (!command || !cwd || command.includes("\0") || cwd.includes("\0")) throw new TypeError("[vitehub] SSH command and cwd are required and cannot contain NUL.")
    return {
      command: process.execPath,
      args: ["--input-type=module", "-e", launcherSource, JSON.stringify({ ...options, port, forwardEnvironment: forwarded, command, cwd })],
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

/** An authenticated command server, not a filesystem or network sandbox. */
export async function serveSsh(options: SshServerOptions): Promise<{ port: number; close(): Promise<void> }> {
  if (process.platform === "win32") throw new Error("[vitehub] SSH command supervision requires a POSIX host.")
  const { default: ssh2 } = await import("ssh2")
  const [hostKey, authorizedKey] = await Promise.all([readFile(options.hostKeyFile), readFile(options.authorizedKeyFile)])
  const parsedKey = ssh2.utils.parseKey(authorizedKey)
  if (parsedKey instanceof Error) throw parsedKey
  const publicKey = Array.isArray(parsedKey) ? parsedKey[0]! : parsedKey
  const clients = new Set<Connection>()
  const sockets = new Set<Socket>()
  const children = new Set<ChildProcess>()
  const terminations = new Map<ChildProcess, Promise<void>>()
  const allowed = options.acceptEnvironment && new Set(options.acceptEnvironment)
  function stop(child: ChildProcess) {
    const pending = terminations.get(child)
    if (pending) return pending
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try { process.kill(-child.pid, signal) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    }
    const done = (async () => {
      signalGroup("SIGTERM")
      await new Promise(resolve => setTimeout(resolve, 250))
      signalGroup("SIGKILL")
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
        const child = spawn("/bin/sh", ["-lc", info.command], {
          cwd: options.cwd,
          detached: true,
          env: { ...process.env, ...environment },
          stdio: ["pipe", "pipe", "pipe"],
        })
        children.add(child)
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
          void stop(child).finally(() => { children.delete(child); terminations.delete(child) })
          stream.exit(code ?? 1)
          stream.end()
        })
      })
    }))
  })
  // Track sockets before SSH identification, so incomplete handshakes cannot hold shutdown open.
  const listener = createServer(socket => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    server.injectSocket(socket)
  })
  const listening = once(listener, "listening")
  listener.listen(options.port ?? 2222, options.host ?? "127.0.0.1")
  await listening
  const address = listener.address()
  let closing: Promise<void> | undefined
  return {
    port: typeof address === "object" && address ? address.port : options.port ?? 2222,
    close() {
      return closing ??= (async () => {
        const closed = new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
        for (const client of clients) client.end()
        await Promise.all([...children].map(stop))
        for (const socket of sockets) socket.destroy()
        await closed
      })()
    },
  }
}

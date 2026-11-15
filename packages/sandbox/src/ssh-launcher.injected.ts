/**
 * Source text of the SSH launcher. It runs in its own Node process outside the application bundle, with only Node and
 * OpenSSH, so its errors are plain. Its exit status and stderr reach the caller of `sshLaunch()`.
 */
export const launcherSource = String.raw`
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const config = JSON.parse(process.argv[1])
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const temporary = await mkdtemp(join(tmpdir(), "vitehub-ssh-"))
try {
  const diagnostics = join(temporary, "diagnostics")
  let knownHostsFile = config.knownHostsFile
  if (config.hostKeyFile) {
    knownHostsFile = join(temporary, "known_hosts")
    const key = (await readFile(config.hostKeyFile, "utf8")).trim()
    if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+(?: .*)?$/.test(key)) throw new Error("Invalid SSH host public key")
    await writeFile(knownHostsFile, "vitehub-runner " + key + "\n", { mode: 0o600 })
  }
  const sshArgs = [
    "-E", diagnostics, "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "LogLevel=ERROR", "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=yes",
    ...(knownHostsFile ? ["-o", "UserKnownHostsFile=" + knownHostsFile] : []),
    ...(config.hostKeyFile ? ["-o", "HostKeyAlias=vitehub-runner"] : []),
    "-i", config.identityFile, "-p", String(config.port),
    ...config.forwardEnvironment.flatMap(name => ["-o", "SendEnv=" + name]),
    config.user + "@" + config.host,
    "cd " + quote(config.cwd) + " && exec " + [config.command, ...process.argv.slice(2)].map(quote).join(" "),
  ]
  // -E separates local OpenSSH diagnostics from remote stderr, which may itself contain an SSH refusal.
  // Only a local connection refusal establishes that the remote command did not start.
  const refused = /^ssh: connect to host \S+ port \d+: Connection refused\r?$/m
  const deadline = Date.now() + config.connectRetryMs
  let child
  let stopped
  let wake
  const handlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => {
    stopped = signal
    if (child) child.kill(signal)
    wake?.()
  }]))
  for (const [signal, handler] of handlers) process.on(signal, handler)
  try {
    for (let delay = 250; ; delay = Math.min(delay * 2, 4000)) {
      await writeFile(diagnostics, "", { mode: 0o600 })
      if (stopped) {
        process.exitCode = 255
        break
      }
      child = spawn("ssh", sshArgs, { stdio: ["inherit", "inherit", "pipe"] })
      child.stderr.on("data", chunk => {
        if (!process.stderr.write(chunk)) {
          child.stderr.pause()
          process.stderr.once("drain", () => child.stderr.resume())
        }
      })
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code, signal) => resolve({ code, signal }))
      })
      const localDiagnostics = await readFile(diagnostics, "utf8")
      process.stderr.write(localDiagnostics)
      const wait = Math.min(delay, deadline - Date.now())
      if (stopped || result.code !== 255 || !refused.test(localDiagnostics) || wait <= 0) {
        process.exitCode = result.code ?? 1
        break
      }
      await new Promise(resolve => {
        const timer = setTimeout(resolve, wait)
        wake = () => { clearTimeout(timer); resolve() }
      })
      wake = undefined
      if (stopped) {
        process.exitCode = 255
        break
      }
    }
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true })
}
`

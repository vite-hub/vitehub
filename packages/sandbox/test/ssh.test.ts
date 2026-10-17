import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import { serveSsh, sshLaunch } from "../src/ssh.ts"
import type { SshLaunchOptions } from "../src/ssh.ts"

const run = promisify(execFile)
const cleanup: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-ssh-test-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const hostKeyFile = join(root, "host")
  const identityFile = join(root, "identity")
  const otherKeyFile = join(root, "other")
  await Promise.all([hostKeyFile, identityFile, otherKeyFile].map(path => run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path])))
  const cwd = join(root, "workspace ' $() ; spaces")
  await mkdir(cwd)
  const server = await serveSsh({
    hostKeyFile,
    authorizedKeyFile: `${identityFile}.pub`,
    user: "agent",
    cwd: root,
    host: "127.0.0.1",
    port: 0,
    acceptEnvironment: ["VITEHUB_SSH_TEST_SECRET"],
  })
  cleanup.push(() => server.close())
  const options = { host: "127.0.0.1", user: "agent", identityFile, hostKeyFile: `${hostKeyFile}.pub`, port: server.port }
  function launch(args: string[], overrides: Partial<SshLaunchOptions> = {}, env: NodeJS.ProcessEnv = {}) {
    const definition = sshLaunch({ ...options, ...overrides })({ command: process.execPath, cwd })
    const child = spawn(definition.command, [...definition.args, ...args], { env: { ...process.env, ...env }, stdio: "pipe" })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", code => resolve({ code, stdout, stderr }))
    })
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
      await done
    })
    return { child, definition, done, stdout: () => stdout }
  }
  return { root, cwd, server, options, otherKeyFile, launch }
}

async function expectStopped(pid: number) {
  await vi.waitFor(async () => {
    try {
      process.kill(pid, 0)
      // Linux may retain an orphan's zombie briefly after the process was killed.
      if (process.platform === "linux") expect(await readFile(`/proc/${pid}/stat`, "utf8")).toMatch(/\) Z /)
      else throw new Error(`Process ${pid} is still running`)
    }
    catch (error) {
      if (!["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
    }
  }, { timeout: 5000 })
}

describe.skipIf(process.platform === "win32")("SSH command runner", () => {
  it("preserves argv, working directory, duplex data, EOF and nonzero exits", async () => {
    const { cwd, launch } = await fixture()
    const args = ["", "one two", "a'b", '"quotes"', "$(touch SHOULD_NOT_EXIST)", "a;b", "line\nbreak"]
    const script = `
      process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) }) + "\\n")
      process.stdin.on("data", chunk => process.stdout.write(chunk))
      process.stdin.on("end", () => { process.stderr.write("finished\\n"); process.exitCode = 23 })
    `
    const child = launch(["-e", script, ...args])
    await vi.waitFor(() => expect(child.stdout()).toContain("\n"))
    child.child.stdin.write("before EOF\n")
    await vi.waitFor(() => expect(child.stdout()).toContain("before EOF\n"))
    child.child.stdin.end("after EOF\n")
    const result = await child.done
    const [metadata, ...lines] = result.stdout.split("\n")
    expect(JSON.parse(metadata!)).toEqual({ cwd, args })
    expect(lines.join("\n")).toBe("before EOF\nafter EOF\n")
    expect(result.stderr).toBe("finished\n")
    expect(result.code).toBe(23)
  }, 15000)

  it("forwards allowed environment values without adding secrets to launch metadata", async () => {
    const { launch } = await fixture()
    const secret = "private-token '$() ; value"
    const child = launch(["-e", "console.log(JSON.stringify({ secret: process.env.VITEHUB_SSH_TEST_SECRET, rejected: process.env.VITEHUB_SSH_TEST_REJECTED }))"], {
      forwardEnvironment: ["VITEHUB_SSH_TEST_SECRET", "VITEHUB_SSH_TEST_REJECTED"],
    }, { VITEHUB_SSH_TEST_SECRET: secret, VITEHUB_SSH_TEST_REJECTED: "must not reach server" })
    child.child.stdin.end()
    expect(JSON.stringify(child.definition)).not.toContain(secret)
    const result = await child.done
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ secret })
  }, 15000)

  it("rejects an untrusted host key and an unauthorized client key", async () => {
    const { launch, otherKeyFile } = await fixture()
    for (const overrides of [{ hostKeyFile: `${otherKeyFile}.pub` }, { identityFile: otherKeyFile }]) {
      const child = launch(["-e", 'console.log("must not run")'], overrides)
      child.child.stdin.end()
      const result = await child.done
      expect(result.code).not.toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).toMatch(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Permission denied/)
    }
  }, 15000)

  it.each(["disconnect", "server close"])("kills command descendants on %s", async (reason) => {
    const { launch, server } = await fixture()
    const script = `
      const { spawn } = require("node:child_process")
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] })
      child.stdout.on("data", data => process.stdout.write(JSON.stringify({ parent: process.pid, child: Number(data) }) + "\\n"))
      setInterval(() => {}, 1000)
    `
    const child = launch(["-e", script])
    await vi.waitFor(() => expect(child.stdout()).toContain("\n"), { timeout: 5000 })
    const pids: { parent: number; child: number } = JSON.parse(child.stdout())
    if (reason === "disconnect") child.child.kill("SIGTERM")
    else await server.close()
    await child.done
    await Promise.all([expectStopped(pids.parent), expectStopped(pids.child)])
    await server.close()
  }, 15000)

  it("cleans up descendants after their parent command exits", async () => {
    const { launch } = await fixture()
    const script = `
      const { spawn } = require("node:child_process")
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "inherit"] })
      child.stdout.once("data", data => {
        process.stdout.write(data, () => process.exit(7))
      })
    `
    const child = launch(["-e", script])
    child.child.stdin.end()
    const result = await child.done
    expect(result.code).toBe(7)
    await expectStopped(Number(result.stdout.trim()))
  }, 15000)

  it("uses a caller-managed known_hosts file", async () => {
    const { root, options, launch } = await fixture()
    const knownHostsFile = join(root, "known_hosts")
    await writeFile(knownHostsFile, `[127.0.0.1]:${options.port} ${await readFile(options.hostKeyFile, "utf8")}`)
    const child = launch(["-e", 'console.log("verified")'], { hostKeyFile: undefined, knownHostsFile })
    child.child.stdin.end()
    expect(await child.done).toEqual({ code: 0, stdout: "verified\n", stderr: "" })
  }, 15000)

  it("closes TCP clients that have not sent SSH identification", async () => {
    const { server } = await fixture()
    const socket = connect({ host: "127.0.0.1", port: server.port, allowHalfOpen: true })
    try {
      const [banner] = await once(socket, "data")
      expect(String(banner)).toMatch(/^SSH-2\.0-/)
      let closed = false
      const closing = server.close().then(() => { closed = true })
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 })
      await closing
    }
    finally {
      socket.destroy()
    }
  }, 15000)
})


describe("SSH launch environment", () => {
  const options = { host: "localhost", user: "agent", identityFile: "/ssh/id_ed25519" }
  it("forwards provider environment names and injected names without serializing secrets", () => {
    const launch = sshLaunch(options)({ command: "codex", cwd: "/workspace", environment: { GH_TOKEN: "private-value", "invalid-name": "skip" }, requiredEnvironment: ["CODEX_HOME", "GH_TOKEN"] })
    const config = JSON.parse(launch.args.at(-1)!)
    expect(config.forwardEnvironment).toEqual(["GH_TOKEN", "CODEX_HOME"])
    expect(launch.args.join(" ")).not.toContain("private-value")
  })
  it("respects an explicit list while retaining framework-required names", () => {
    const launch = sshLaunch({ ...options, forwardEnvironment: [] })({ command: "codex", cwd: "/workspace", environment: { GH_TOKEN: "secret" }, requiredEnvironment: ["CODEX_HOME"] })
    expect(JSON.parse(launch.args.at(-1)!).forwardEnvironment).toEqual(["CODEX_HOME"])
  })
})

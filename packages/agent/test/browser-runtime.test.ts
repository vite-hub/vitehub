import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { lock } from "proper-lockfile"
import { afterEach, describe, expect, it, vi } from "vitest"
import { closeBrowserRuntimeSession, browserRuntimeEnvironment, prepareBrowserRuntime, provideBrowserRuntimeEnvironment, resetBrowserRuntimePreparationForTest } from "../src/internal/browser-runtime.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"

vi.mock("proper-lockfile", async (importOriginal) => {
  const original = await importOriginal<typeof import("proper-lockfile")>()
  return { ...original, lock: vi.fn(original.lock) }
})

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vh-browser-test-"))
  roots.push(root)
  const npm = join(root, "npm-fixture")
  const count = join(root, "installs")
  await writeFile(npm, `#!/usr/bin/env node
process.umask(0o022);
const fs=require('node:fs'),path=require('node:path'); const here=path.dirname(process.argv[1]); fs.appendFileSync(path.join(here,'installs'),'1\\n'); if(fs.existsSync(path.join(here,'delay'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);
const fail=path.join(here,'fail-next'); if(fs.existsSync(fail)){fs.unlinkSync(fail);process.exit(7)}
const prefix=process.argv[process.argv.indexOf('--prefix')+1],bin=path.join(prefix,'node_modules','.bin'); fs.mkdirSync(bin,{recursive:true});
const browsers=path.join(bin,'browsers'); fs.writeFileSync(browsers,\`#!/usr/bin/env node
process.umask(0o022);
const fs=require('node:fs'),path=require('node:path'),root=process.argv[process.argv.indexOf('--path')+1],dir=path.join(root,'chrome','mac_arm-149.0.7827.155','chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS'); if(process.argv[3]!=='chrome@149.0.7827.155') process.exit(8); fs.mkdirSync(dir,{recursive:true}); const chrome=path.join(dir,'Google Chrome for Testing'); fs.writeFileSync(chrome,"#!/usr/bin/env node\\\\nprocess.stdout.write('<html></html>')\\\\n"); fs.chmodSync(chrome,0o755);\`); fs.chmodSync(browsers,0o755);
const cli=path.join(bin,'agent-browser'); fs.writeFileSync(cli,"#!/usr/bin/env node\\nprocess.stdout.write('agent-browser 0.35.2')\\n"); fs.chmodSync(cli,0o755);
const skill=path.join(prefix,'node_modules','agent-browser','skills','agent-browser'); fs.mkdirSync(skill,{recursive:true}); fs.writeFileSync(path.join(skill,'SKILL.md'),'---\\nname: agent-browser\\nhidden: true\\n---\\nInstall: remove me\\nRun agent-browser skills get core.\\n');
`)
  await chmod(npm, 0o755)
  return { cache: join(root, "cache"), count, npm, root }
}

afterEach(async () => {
  vi.mocked(lock).mockClear()
  resetBrowserRuntimePreparationForTest()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("browser runtime", () => {
  it("waits for the cache lock before inspecting files being replaced", async () => {
    const value = await fixture()
    await mkdir(value.cache, { mode: 0o700 })
    const pendingLink = join(value.cache, "pending-command")
    await symlink("not-yet-published", pendingLink)
    const original = await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")
    vi.mocked(lock).mockImplementationOnce(async (path, options) => {
      // Model the current owner completing publication before handing off.
      await unlink(pendingLink)
      return original.lock(path, options)
    })
    const prepared = await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    expect(lock).toHaveBeenCalledTimes(1)
    await closeBrowserRuntimeSession({ ...prepared.environment, AGENT_BROWSER_SESSION: "lock-handoff" })
  })

  it("does not accept input context as a managed browser environment", () => {
    const context = createAgentInvocationContextStore({
      "vitehub.browser.runtime.environment": { NODE_OPTIONS: "--require=untrusted.cjs", PATH: "/untrusted/bin" },
    })
    expect(browserRuntimeEnvironment(context)).toBeUndefined()
    const environment = Object.freeze({ PATH: "/managed/bin" })
    provideBrowserRuntimeEnvironment(context, environment)
    context.set("vitehub.browser.runtime.environment", { PATH: "/replacement/bin" }, { overwrite: true })
    expect(browserRuntimeEnvironment(context)).toBe(environment)
  })

  it("reports browser session cleanup failures", async () => {
    const value = await fixture()
    const command = join(value.root, process.platform === "win32" ? "agent-browser.cmd" : "agent-browser")
    const environment = { PATH: value.root, AGENT_BROWSER_SESSION: "cleanup-test" }
    await expect(closeBrowserRuntimeSession(environment)).rejects.toThrow("ENOENT")
    await writeFile(command, "#!/usr/bin/env node\nprocess.exit(7)\n")
    await chmod(command, 0o755)
    await expect(closeBrowserRuntimeSession(environment)).rejects.toThrow("exit 7")
    await writeFile(command, "#!/usr/bin/env node\nprocess.exit(0)\n")
    await expect(closeBrowserRuntimeSession(environment)).resolves.toBeUndefined()
  })

  it("scopes prepared environment to one invocation", () => {
    const one = createAgentInvocationContextStore(), two = createAgentInvocationContextStore()
    const env = Object.freeze({ PATH: "/managed/bin" })
    provideBrowserRuntimeEnvironment(one, env)
    expect(browserRuntimeEnvironment(one)).toBe(env)
    expect(browserRuntimeEnvironment(two)).toBeUndefined()
  })

  it.each(["option", "environment"])("resolves a relative cache from %s before exposing provider paths", async (source) => {
    const value = await fixture()
    const cache = relative(process.cwd(), value.cache)
    if (source === "environment") vi.stubEnv("VITEHUB_CACHE_DIR", cache)
    const ready = await prepareBrowserRuntime({ cacheRoot: source === "option" ? cache : undefined, npmCommand: value.npm, platform: "darwin" })
    expect(isAbsolute(ready.command)).toBe(true)
    expect(isAbsolute(ready.environment.AGENT_BROWSER_EXECUTABLE_PATH!)).toBe(true)
    const result = await promisify(execFile)(ready.command, ["--version"], { cwd: value.root, env: { ...process.env, ...ready.environment, PATH: `${ready.environment.PATH}:${process.env.PATH}` } })
    expect(result.stdout).toContain("0.35.2")
  })

  it("deduplicates concurrent preparation and revalidates a retained cache", async () => {
    const value = await fixture()
    const [one, two] = await Promise.all([prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" }), prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })])
    expect(two).toBe(one)
    expect(one.environment.AGENT_BROWSER_EXECUTABLE_PATH).toContain("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
    expect(one.skillContent).toContain("skills get core")
    expect(one.skillContent).not.toContain("hidden: true")
    expect(one.skillContent).toContain("Keep the configured `AGENT_BROWSER_SESSION`")
    await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    expect((await readFile(value.count, "utf8")).trim().split("\n")).toHaveLength(1)
  })

  it.each([false, true])("reclaims interrupted staging directories with a ready cache: %s", async (ready) => {
    const value = await fixture()
    const options = { cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" as const }
    if (ready) await prepareBrowserRuntime(options)
    const abandoned = `${value.cache}.install-123-abandoned`
    const unrelated = join(value.root, "other-cache.install-123-abandoned")
    await mkdir(abandoned)
    await writeFile(join(abandoned, "partial-browser"), "interrupted payload")
    await mkdir(unrelated)
    await writeFile(join(unrelated, "keep"), "other runtime")
    resetBrowserRuntimePreparationForTest()

    await prepareBrowserRuntime(options)

    expect(await readdir(value.root)).not.toContain("cache.install-123-abandoned")
    expect(await readFile(join(unrelated, "keep"), "utf8")).toBe("other runtime")
    expect((await readFile(value.count, "utf8")).trim().split("\n")).toHaveLength(1)
  })

  it("repairs a cache with a different Chrome build", async () => {
    const value = await fixture()
    await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    const ownedRoot = await lstat(value.cache)
    const markerPath = join(value.cache, "ready.json")
    const marker = JSON.parse(await readFile(markerPath, "utf8"))
    expect(marker.browserVersion).toBe("149.0.7827.155")
    await writeFile(markerPath, JSON.stringify({ ...marker, browserVersion: "148.0.0.0" }))
    await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    expect((await readFile(value.count, "utf8")).trim().split("\n")).toHaveLength(2)
    expect(JSON.parse(await readFile(markerPath, "utf8")).browserVersion).toBe("149.0.7827.155")
    expect((await lstat(value.cache)).ino).toBe(ownedRoot.ino)
  })

  it("repairs a cached CLI that cannot execute", async () => {
    const value = await fixture()
    const ready = await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    await chmod(ready.command, 0o600)
    await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    expect((await readFile(value.count, "utf8")).trim().split("\n")).toHaveLength(2)
  })

  it("rejects an untrusted cached command before executing it", async () => {
    const value = await fixture()
    const ready = await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    const executed = join(value.root, "executed")
    await writeFile(ready.command, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(executed)}, '1')\n`)
    await chmod(ready.command, 0o777)
    await expect(prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })).rejects.toThrow("trusted ownership and permissions")
    await expect(readFile(executed)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await readFile(value.count, "utf8")).trim().split("\n")).toHaveLength(1)
  })

  it("rejects a symlink in the browser socket ancestor chain", async () => {
    const value = await fixture()
    const target = join(value.root, "untrusted")
    const linkedTemp = join(value.root, "linked-temp")
    await mkdir(target)
    await symlink(target, linkedTemp)
    vi.stubEnv("TMPDIR", linkedTemp)
    await expect(prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })).rejects.toThrow("private directory")
    expect(await readdir(target)).toEqual([])
  })

  it("removes socket directories when installation fails", async () => {
    const value = await fixture()
    vi.stubEnv("TMPDIR", value.root)
    await writeFile(join(value.root, "fail-next"), "1")
    await expect(prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })).rejects.toThrow("exit 7")
    expect((await readdir(value.root)).filter(name => name.startsWith("vh-ab-"))).toEqual([])
  })

  it("stops awaiting shared provisioning when one invocation is cancelled", async () => {
    const value = await fixture()
    await writeFile(join(value.root, "delay"), "1")
    const abort = new AbortController()
    const options = { cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" as const }
    const pending = prepareBrowserRuntime({ ...options, abortSignal: abort.signal })
    const shared = prepareBrowserRuntime(options)
    await vi.waitFor(async () => expect(await readFile(value.count, "utf8")).toBe("1\n"))
    const reason = new Error("cancel browser preparation")
    abort.abort(reason)
    await expect(pending).rejects.toBe(reason)
    const later = prepareBrowserRuntime(options)
    await expect(shared).resolves.toHaveProperty("command")
    await expect(later).resolves.toBe(await shared)
    expect(lock).toHaveBeenCalledTimes(1)
    expect((await readFile(value.count, "utf8")).trim().split("\n")).toHaveLength(1)
  })

  it("replaces a pending lock wait only after all consumers cancel", async () => {
    const value = await fixture()
    let rejectLock!: (error: Error) => void
    vi.mocked(lock).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLock = reject }))
    const options = { cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" as const }
    const first = new AbortController()
    const second = new AbortController()
    const one = prepareBrowserRuntime({ ...options, abortSignal: first.signal })
    const two = prepareBrowserRuntime({ ...options, abortSignal: second.signal })
    await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(1))
    first.abort(new Error("first cancelled"))
    await expect(one).rejects.toThrow("first cancelled")
    second.abort(new Error("second cancelled"))
    await expect(two).rejects.toThrow("second cancelled")

    let releaseReplacement!: () => void
    vi.mocked(lock).mockImplementationOnce(() => new Promise(resolve => { releaseReplacement = () => resolve(async () => {}) }))
    const replacement = prepareBrowserRuntime(options)
    await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(2))
    // A retired generation must not evict the replacement when it eventually fails.
    rejectLock(new Error("abandoned lock wait failed"))
    await new Promise(resolve => setImmediate(resolve))
    const sharedReplacement = prepareBrowserRuntime(options)
    releaseReplacement()
    await expect(sharedReplacement).resolves.toBe(await replacement)
    expect(lock).toHaveBeenCalledTimes(2)
  })

  it("cancels a cached Linux probe without orphaning Chromium or reinstalling", async () => {
    const value = await fixture()
    vi.stubEnv("TMPDIR", value.root)
    const ready = await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    const markerPath = join(value.cache, "ready.json")
    const marker = JSON.parse(await readFile(markerPath, "utf8"))
    await writeFile(markerPath, JSON.stringify({ ...marker, linuxBundle: true, browserVersion: "149.0.0" }))
    const started = join(value.root, "chrome-started.json")
    await writeFile(ready.environment.AGENT_BROWSER_EXECUTABLE_PATH!, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid, profile: process.argv.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length) }));
setInterval(() => {}, 1000);
`)
    const socketsBefore = (await readdir(value.root)).filter(name => name.startsWith("vh-ab-"))
    const controller = new AbortController()
    const pending = prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "linux", abortSignal: controller.signal })
    await vi.waitFor(async () => expect(await readFile(started, "utf8")).toContain("pid"))
    const { pid, profile } = JSON.parse(await readFile(started, "utf8"))
    try {
      controller.abort(new Error("cancel Linux smoke"))
      await expect(pending).rejects.toThrow("cancel Linux smoke")
      // Consumer rejection is immediate; the provisioner releases its lock
      // only after the wrapper has reaped Chromium and removed the profile.
      await vi.waitFor(async () => {
        expect(() => process.kill(pid, 0)).toThrow()
        await expect(lstat(profile)).rejects.toHaveProperty("code", "ENOENT")
        expect((await readdir(value.root)).filter(name => name.startsWith("vh-ab-"))).toEqual(socketsBefore)
        await expect(lstat(`${value.cache}.lock`)).rejects.toHaveProperty("code", "ENOENT")
      })
      expect((await readFile(value.count, "utf8")).trim().split("\n")).toHaveLength(1)
    }
    finally {
      try { process.kill(pid, "SIGKILL") } catch { /* Already reaped. */ }
      await rm(profile, { recursive: true, force: true })
    }
  })

  it("serializes invalid cache repair across Node processes", async () => {
    const value = await fixture()
    const ready = await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    await chmod(ready.command, 0o600)
    const script = `import { prepareBrowserRuntime } from ${JSON.stringify(new URL("../src/internal/browser-runtime.ts", import.meta.url).href)};
      const runtime = await prepareBrowserRuntime(JSON.parse(process.argv[1]));
      console.log(runtime.command);`
    const run = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script,
      JSON.stringify({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })])
    const [one, two] = await Promise.all([run(), run()])
    expect(one.stdout.trim()).toBe(ready.command)
    expect(two.stdout.trim()).toBe(ready.command)
    expect((await readFile(value.count, "utf8")).trim().split("\n")).toHaveLength(2)
  })

  it("retries failed installs and repairs a missing browser", async () => {
    const value = await fixture()
    await writeFile(join(value.root, "fail-next"), "1")
    await expect(prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })).rejects.toThrow("exit 7")
    const ready = await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    await unlink(ready.environment.AGENT_BROWSER_EXECUTABLE_PATH!)
    const repaired = await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    expect(repaired.environment.AGENT_BROWSER_EXECUTABLE_PATH).toBe(ready.environment.AGENT_BROWSER_EXECUTABLE_PATH)
    expect((await readFile(value.count, "utf8")).trim().split("\n")).toHaveLength(3)
  })
})

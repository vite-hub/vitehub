import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { browserRuntimeEnvironment, prepareBrowserRuntime, provideBrowserRuntimeEnvironment, resetBrowserRuntimePreparationForTest } from "../src/internal/browser-runtime.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vh-browser-test-"))
  roots.push(root)
  const npm = join(root, "npm-fixture")
  const count = join(root, "installs")
  await writeFile(npm, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'); const here=path.dirname(process.argv[1]); fs.appendFileSync(path.join(here,'installs'),'1\\n');
const fail=path.join(here,'fail-next'); if(fs.existsSync(fail)){fs.unlinkSync(fail);process.exit(7)}
const prefix=process.argv[process.argv.indexOf('--prefix')+1],bin=path.join(prefix,'node_modules','.bin'); fs.mkdirSync(bin,{recursive:true});
const browsers=path.join(bin,'browsers'); fs.writeFileSync(browsers,\`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),root=process.argv[process.argv.indexOf('--path')+1],dir=path.join(root,'chrome','mac_arm-149.0.7827.155','chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS'); if(process.argv[3]!=='chrome@149.0.7827.155') process.exit(8); fs.mkdirSync(dir,{recursive:true}); const chrome=path.join(dir,'Google Chrome for Testing'); fs.writeFileSync(chrome,"#!/usr/bin/env node\\\\nprocess.stdout.write('<html></html>')\\\\n"); fs.chmodSync(chrome,0o755);\`); fs.chmodSync(browsers,0o755);
const cli=path.join(bin,'agent-browser'); fs.writeFileSync(cli,"#!/usr/bin/env node\\nprocess.exit(0)\\n"); fs.chmodSync(cli,0o755);
const skill=path.join(prefix,'node_modules','agent-browser','skills','agent-browser'); fs.mkdirSync(skill,{recursive:true}); fs.writeFileSync(path.join(skill,'SKILL.md'),'---\\nname: agent-browser\\nhidden: true\\n---\\nInstall: remove me\\nRun agent-browser skills get core.\\n');
`)
  await chmod(npm, 0o755)
  return { cache: join(root, "cache"), count, npm, root }
}

afterEach(async () => {
  resetBrowserRuntimePreparationForTest()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("browser runtime", () => {
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

  it("scopes prepared environment to one invocation", () => {
    const one = createAgentInvocationContextStore(), two = createAgentInvocationContextStore()
    const env = Object.freeze({ PATH: "/managed/bin" })
    provideBrowserRuntimeEnvironment(one, env)
    expect(browserRuntimeEnvironment(one)).toBe(env)
    expect(browserRuntimeEnvironment(two)).toBeUndefined()
  })

  it("deduplicates concurrent preparation and reuses a validated restart cache", async () => {
    const value = await fixture()
    const [one, two] = await Promise.all([prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" }), prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })])
    expect(two).toBe(one)
    expect(one.environment.AGENT_BROWSER_EXECUTABLE_PATH).toContain("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
    expect(one.skillContent).toContain("skills get core")
    expect(one.skillContent).not.toContain("hidden: true")
    expect(one.skillContent).toContain("Keep the configured `AGENT_BROWSER_SESSION`")
    resetBrowserRuntimePreparationForTest()
    await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    expect((await readFile(value.count, "utf8")).trim().split("\n")).toHaveLength(1)
  })

  it("repairs a cache with a different Chrome build", async () => {
    const value = await fixture()
    await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    const markerPath = join(value.cache, "ready.json")
    const marker = JSON.parse(await readFile(markerPath, "utf8"))
    expect(marker.browserVersion).toBe("149.0.7827.155")
    await writeFile(markerPath, JSON.stringify({ ...marker, browserVersion: "148.0.0.0" }))
    resetBrowserRuntimePreparationForTest()
    await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    expect((await readFile(value.count, "utf8")).trim().split("\n")).toHaveLength(2)
    expect(JSON.parse(await readFile(markerPath, "utf8")).browserVersion).toBe("149.0.7827.155")
  })

  it("retries failed installs and repairs a missing browser", async () => {
    const value = await fixture()
    await writeFile(join(value.root, "fail-next"), "1")
    await expect(prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })).rejects.toThrow("exit 7")
    const ready = await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    await unlink(ready.environment.AGENT_BROWSER_EXECUTABLE_PATH!)
    resetBrowserRuntimePreparationForTest()
    const repaired = await prepareBrowserRuntime({ cacheRoot: value.cache, npmCommand: value.npm, platform: "darwin" })
    expect(repaired.environment.AGENT_BROWSER_EXECUTABLE_PATH).toBe(ready.environment.AGENT_BROWSER_EXECUTABLE_PATH)
    expect((await readFile(value.count, "utf8")).trim().split("\n")).toHaveLength(3)
  })
})

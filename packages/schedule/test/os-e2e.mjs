//   node packages/schedule/test/os-e2e.mjs --scope user --percent-home
//
// `--percent-home` runs with HOME, USERPROFILE and LOCALAPPDATA under a folder named `pct %PATH% home`. Task Scheduler
// expands `%NAME%` in the arguments of a task, so the wrapper path must not appear there.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs, promisify } from "node:util"

import { installOsSchedule, osScheduleStatus, uninstallOsSchedule } from "../dist/os.js"

const { values } = parseArgs({ options: { "scope": { type: "string", default: "user" }, "moved-home": { type: "boolean", default: false }, "percent-home": { type: "boolean", default: false } }, strict: true })
const scope = values.scope
assert.ok(scope === "user" || scope === "system", `--scope must be "user" or "system", got "${scope}"`)

const waitMs = 180_000
const pollMs = 5_000
const run = promisify(execFile)
const name = `os-e2e-${randomBytes(4).toString("hex")}`
const dir = mkdtempSync(join(tmpdir(), "vitehub-os-e2e-"))
const marker = join(dir, "marker.txt")
const logDir = join(dir, "logs")
const command = [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1],process.env.VITEHUB_OS_E2E+'\\n')", marker]
const target = { scope }

if (values["moved-home"]) {
  mkdirSync(join(dir, "real-home"))
  symlinkSync(join(dir, "real-home"), join(dir, "home"), "dir")
  process.env.HOME = join(dir, "home")
  process.env.XDG_CONFIG_HOME = join(dir, "home", ".config")
}

if (values["percent-home"]) {
  const home = join(dir, "pct %PATH% home")
  mkdirSync(home)
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.LOCALAPPDATA = join(home, "AppData", "Local")
}

function step(message) {
  console.log(`[os-e2e] ${message}`)
}

function unwrap([error, data], what) {
  if (error) assert.fail(`${what} failed: ${error.code ?? error.name}: ${error.message}\n${JSON.stringify(error.data ?? {}, null, 2)}`)
  return data
}

function install(env) {
  return installOsSchedule(name, { cron: "* * * * *" }, { command, scope, env, logDir })
}

async function probe(file, args) {
  try {
    const { stdout, stderr } = await run(file, args, { windowsHide: true })
    return { code: 0, output: `${stdout}${stderr}`.trim() }
  }
  catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, output: `${error.stdout ?? ""}${error.stderr ?? error.message}`.trim() }
  }
}

async function osKnows() {
  if (process.platform === "linux") {
    const user = scope === "user" ? ["--user"] : []
    const timer = await probe("systemctl", [...user, "cat", `${name}.timer`])
    const service = await probe("systemctl", [...user, "cat", `${name}.service`])
    return { known: timer.code === 0 || service.code === 0, output: `${timer.output}\n${service.output}` }
  }
  if (process.platform === "darwin") {
    const uid = process.getuid()
    const domains = scope === "system" ? ["system"] : [`gui/${uid}`, `user/${uid}`]
    const results = await Promise.all(domains.map(domain => probe("launchctl", ["print", `${domain}/${name}`])))
    return { known: results.some(result => result.code === 0), output: results.map(result => result.output).join("\n") }
  }
  const result = await probe("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-ScheduledTask -TaskName '${name}' -TaskPath '\\' -ErrorAction Stop | Format-List TaskName,State`])
  return { known: result.code === 0, output: result.output }
}

async function diagnose(unit) {
  const status = unit ? await unit.status() : await osScheduleStatus(name, target)
  console.log("[os-e2e] last status:", JSON.stringify(status, null, 2))
  console.log("[os-e2e] OS view:", (await osKnows()).output)
  if (process.platform === "linux") {
    const user = scope === "user" ? ["--user"] : []
    console.log((await probe("systemctl", [...user, "status", "--no-pager", `${name}.timer`, `${name}.service`])).output)
  }
  for (const file of [marker, join(logDir, `${name}.log`)]) {
    console.log(`[os-e2e] ${file}:`, existsSync(file) ? readFileSync(file, "utf8") : "(missing)")
  }
}

let removed = false
let unit
try {
  step(`platform ${process.platform}, scope ${scope}, name ${name}, temp dir ${dir}, HOME ${process.env.HOME}, LOCALAPPDATA ${process.env.LOCALAPPDATA}`)

  step("install")
  unit = unwrap(await install({ VITEHUB_OS_E2E: "1" }), "first install")
  assert.equal(unit.name, name)
  assert.equal(unit.platform, process.platform)
  assert.equal(unit.scope, scope)
  assert.equal(unit.changed, true, "a first install must report changed: true")
  assert.ok(unit.files.length > 0, "install must report the files it owns")
  for (const file of unit.files.filter(file => !file.endsWith(".log"))) assert.ok(existsSync(file), `installed file is missing: ${file}`)
  step(`files: ${unit.files.join(", ")}`)
  if (unit.linger !== undefined) step(`linger: ${unit.linger}`)

  step("install again with the same input")
  const same = unwrap(await install({ VITEHUB_OS_E2E: "1" }), "second install")
  assert.equal(same.changed, false, "an identical install must report changed: false")

  step("install again with a changed env")
  unit = unwrap(await install({ VITEHUB_OS_E2E: "2" }), "third install")
  assert.equal(unit.changed, true, "an install with a changed env must report changed: true")

  const listed = await osKnows()
  assert.ok(listed.known, `the OS does not list ${name} after install:\n${listed.output}`)

  step(`wait up to ${waitMs / 1000} s for the OS scheduler to run it`)
  const started = Date.now()
  let status
  while (true) {
    status = unwrap(await unit.status(), "status")
    if (status.lastExitCode === 0 && existsSync(marker) && /^2$/m.test(readFileSync(marker, "utf8"))) break
    if (Date.now() - started > waitMs) {
      assert.fail(`the OS scheduler did not run ${name} with exit code 0 in ${waitMs / 1000} s`)
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  step(`ran after ${Math.round((Date.now() - started) / 1000)} s`)
  assert.equal(status.installed, true)
  console.log(JSON.stringify(status, null, 2))

  step("uninstall")
  const removal = unwrap(await unit.uninstall(), "uninstall")
  removed = true
  assert.equal(removal.existed, true)
  for (const file of unit.files) assert.ok(!existsSync(file), `uninstall left a file: ${file}`)
  const after = unwrap(await osScheduleStatus(name, target), "status after uninstall")
  assert.equal(after.installed, false, "status must report installed: false after uninstall")
  const gone = await osKnows()
  assert.ok(!gone.known, `the OS still lists ${name} after uninstall:\n${gone.output}`)

  step("passed")
}
catch (error) {
  process.exitCode = 1
  console.error(error)
  await diagnose(unit).catch(error => console.error(error))
}
finally {
  if (!removed) {
    step("clean up after the failure")
    const [error] = await uninstallOsSchedule(name, target)
    if (error) {
      process.exitCode = 1
      console.error(`[os-e2e] cleanup failed: ${error.code}: ${error.message}`)
    }
  }
  rmSync(dir, { recursive: true, force: true })
}

import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

import { parseCronFields } from "../src/os/cron.ts"
import { launchdIntervals, parseLaunchdPlist, renderLaunchdPlist } from "../src/os/launchd.ts"
import { renderSystemdService, renderSystemdTimer } from "../src/os/systemd.ts"
import { parseTaskWrapperLog, renderTaskWrapper, renderTaskXml, taskDescriptionHash, taskOwnerScope, taskTriggers } from "../src/os/task-scheduler.ts"
import { clockChanges } from "../src/os/time-zone.ts"

import type { OsTimerSpec } from "../src/os/host.ts"

const fixtures = join(import.meta.dirname, "fixtures/os")
const systemdAnalyze = spawnSync("systemd-analyze", ["--version"]).status === 0

function spec(cron: string, overrides: Partial<OsTimerSpec> = {}): OsTimerSpec {
  const name = overrides.name ?? "skync"
  return {
    name,
    description: `${name} (ViteHub schedule)`,
    cron,
    fields: parseCronFields(cron)!,
    timeZone: "UTC",
    command: ["/usr/bin/node", "/home/me/skync/bin.mjs", "sync", "--scheduled"],
    env: {},
    catchUp: true,
    ...overrides,
  }
}

const skync = spec("0 9 * * 1-5", { timeZone: "Europe/Madrid" })
const backup = spec("*/15 * 1,15 * 0", {
  name: "backup-db",
  description: "Back up the database at 50% load",
  command: ["/opt/backup tools/bin/backup", "--label", "say \"hi\"", "$HOME"],
  env: { PATH: "/usr/bin:/bin", GREETING: "50% \"off\"" },
  cwd: "/srv/backup",
  logDir: "/var/log/backup-db",
  catchUp: false,
  randomDelaySeconds: 60,
})

function triggers(cron: string) {
  const result = taskTriggers(parseCronFields(cron)!)
  if (typeof result === "string") throw new Error(result)
  return result
}

describe("systemd units", () => {
  it("writes a user timer for weekdays in a time zone", async () => {
    await expect(renderSystemdService(skync)).toMatchFileSnapshot(join(fixtures, "skync.service"))
    await expect(renderSystemdTimer(skync)).toMatchFileSnapshot(join(fixtures, "skync.timer"))
  })

  it("writes a timer with a log file, environment, random delay, and both day fields", async () => {
    await expect(renderSystemdService(backup)).toMatchFileSnapshot(join(fixtures, "backup-db.service"))
    await expect(renderSystemdTimer(backup)).toMatchFileSnapshot(join(fixtures, "backup-db.timer"))
  })

  // systemd-analyze verify loads every unit of the machine, which takes seconds on a busy machine.
  it.skipIf(!systemdAnalyze)("passes systemd-analyze verify", () => {
    const directory = mkdtempSync(join(tmpdir(), "vitehub-os-render-"))
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
    const files: string[] = []
    for (const unit of [skync, backup]) {
      const runnable = { ...unit, name: `vitehub-verify-${unit.name}`, command: ["/bin/sh", "-c", "echo \"$HOME\" 50%"], ...(unit.cwd ? { cwd: directory, logDir: directory } : {}) }
      for (const [suffix, text] of [["service", renderSystemdService(runnable)], ["timer", renderSystemdTimer(runnable)]] as const) {
        const file = join(directory, `${runnable.name}.${suffix}`)
        writeFileSync(file, text)
        files.push(file)
      }
    }
    const result = spawnSync("systemd-analyze", ["--man=no", "verify", ...files], { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C" } })
    expect(`${result.stdout}${result.stderr}`.split("\n").filter(line => line.includes("vitehub-verify-"))).toEqual([])
    expect(result.status).toBe(0)
  }, 60_000)
})

describe("launchd plist", () => {
  it("writes a LaunchAgent", async () => {
    const intervals = launchdIntervals(skync.fields)
    if (typeof intervals === "string") throw new Error(intervals)
    const plist = renderLaunchdPlist(skync, intervals, "/Users/me/Library/Logs/skync/skync.log")
    await expect(plist).toMatchFileSnapshot(join(fixtures, "skync.plist"))
    expect(parseLaunchdPlist(plist)).toEqual({ intervals, logFile: "/Users/me/Library/Logs/skync/skync.log" })
  })

  it("writes environment, a working directory, and the day and weekday dicts", async () => {
    const job = spec("0 3 1 * 1", { name: "backup-db", env: { PATH: "/usr/bin:/bin", TOKEN: "a&b<c>" }, cwd: "/Users/me/Backups & Co" })
    const intervals = launchdIntervals(job.fields)
    if (typeof intervals === "string") throw new Error(intervals)
    const plist = renderLaunchdPlist(job, intervals, "/Users/me/Backups & Co/backup-db.log")
    await expect(plist).toMatchFileSnapshot(join(fixtures, "backup-db.plist"))
    expect(parseLaunchdPlist(plist)).toEqual({ intervals, logFile: "/Users/me/Backups & Co/backup-db.log" })
  })

  it.skipIf(spawnSync("plutil", ["-help"]).error !== undefined)("passes plutil -lint", () => {
    const directory = mkdtempSync(join(tmpdir(), "vitehub-os-plist-"))
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
    const file = join(directory, "backup-db.plist")
    const intervals = launchdIntervals(backup.fields)
    if (typeof intervals === "string") throw new Error(intervals)
    writeFileSync(file, renderLaunchdPlist(backup, intervals, "/tmp/backup-db.log"))
    expect(execFileSync("plutil", ["-lint", file], { encoding: "utf8" })).toContain("OK")
  })
})

describe("Task Scheduler task", () => {
  const userWrapper = "C:\\Users\\me\\AppData\\Local\\ViteHub\\schedules\\skync.ps1"

  it("writes a user task that repeats inside the day on weekdays", async () => {
    const job = spec("*/15 9-17 * * 1-5", { command: ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\me\\skync\\bin.mjs", "sync"] })
    const wrapperText = renderTaskWrapper(job, "C:\\Users\\me\\AppData\\Local\\skync\\Logs\\skync.log")
    await expect(renderTaskXml(job, triggers(job.cron), { scope: "user", userId: "DESKTOP-1\\me", wrapper: userWrapper, wrapperText })).toMatchFileSnapshot(join(fixtures, "skync-user.xml"))
  })

  it("writes a SYSTEM task with a random delay and both day fields", async () => {
    const job = spec("0,30 9,18 1 * 1", { name: "backup-db", randomDelaySeconds: 90, catchUp: false })
    const wrapperText = renderTaskWrapper(job, "C:\\ProgramData\\backup-db\\Logs\\backup-db.log")
    await expect(renderTaskXml(job, triggers(job.cron), { scope: "system", userId: "DESKTOP-1\\me", wrapper: "C:\\ProgramData\\ViteHub\\schedules\\backup-db.ps1", wrapperText })).toMatchFileSnapshot(join(fixtures, "backup-db-system.xml"))
  })

  it("writes monthly triggers", async () => {
    const job = spec("5 4 1,15 1-3 *", { name: "report" })
    const wrapperText = renderTaskWrapper(job, "C:\\Users\\me\\AppData\\Local\\report\\Logs\\report.log")
    await expect(renderTaskXml(job, triggers(job.cron), { scope: "user", userId: "DESKTOP-1\\me", wrapper: userWrapper, wrapperText })).toMatchFileSnapshot(join(fixtures, "report-user.xml"))
  })

  it("writes a time trigger that repeats without end on a machine with clock changes", async () => {
    const job = spec("*/15 * * * *", { name: "pulse" })
    const result = taskTriggers(job.fields, { timeZone: "Europe/Madrid", changes: clockChanges("Europe/Madrid", new Date("2027-01-04T00:00:00Z")) })
    if (typeof result === "string") throw new Error(result)
    const wrapperText = renderTaskWrapper(job, "C:\\Users\\me\\AppData\\Local\\pulse\\Logs\\pulse.log")
    await expect(renderTaskXml(job, result, { scope: "user", userId: "DESKTOP-1\\me", wrapper: userWrapper, wrapperText })).toMatchFileSnapshot(join(fixtures, "pulse-user.xml"))
  })

  // Task Scheduler expands %NAME% in the arguments, so a wrapper under such a folder was never found.
  it("keeps % out of the task arguments and runs the wrapper by its exact path", () => {
    const job = spec("0 * * * *")
    const wrapper = "C:\\Users\\pct %PATH% O'Brien\\AppData\\Local\\ViteHub\\schedules\\skync.ps1"
    const taskArguments = /<Arguments>(.*)<\/Arguments>/.exec(renderTaskXml(job, triggers(job.cron), { scope: "user", userId: "DESKTOP-1\\me", wrapper, wrapperText: "" }))![1]!
    expect(taskArguments).not.toContain("%")
    const encoded = / -EncodedCommand (\S+)$/.exec(taskArguments)![1]!
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe("$global:LASTEXITCODE = 1\n& 'C:\\Users\\pct %PATH% O''Brien\\AppData\\Local\\ViteHub\\schedules\\skync.ps1'\nexit $global:LASTEXITCODE")
  })

  it("marks the task with its scope", () => {
    const job = spec("0 * * * *")
    const description = (scope: "user" | "system") => /<Description>(.*)<\/Description>/.exec(renderTaskXml(job, triggers(job.cron), { scope, userId: "DESKTOP-1\\me", wrapper: userWrapper, wrapperText: "" }))![1]
    expect(taskOwnerScope(description("user"))).toBe("user")
    expect(taskOwnerScope(description("system"))).toBe("system")
    expect(taskOwnerScope("Backs up my photos. Managed by ViteHub.")).toBeUndefined()
    expect(taskOwnerScope(undefined)).toBeUndefined()
  })

  it("writes a PowerShell wrapper that sets the environment and appends the output to the log", async () => {
    const job = spec("0 * * * *", {
      command: ["C:\\Program Files\\nodejs\\node.exe", "-e", "console.log('it’s done')"],
      env: { PATH: "C:\\Windows\\System32", NAME: "O'Brien" },
      cwd: "C:\\Users\\me\\skync",
    })
    const logFile = "C:\\Users\\me\\O'Brien\\skync.log"
    const wrapper = renderTaskWrapper(job, logFile)
    expect(wrapper.startsWith("\uFEFF")).toBe(true)
    await expect(wrapper).toMatchFileSnapshot(join(fixtures, "skync.ps1"))
    expect(parseTaskWrapperLog(wrapper)).toBe(logFile)
  })

  it("hashes the XML and the wrapper into the description", () => {
    const job = spec("0 * * * *")
    const options = { scope: "user" as const, userId: "DESKTOP-1\\me", wrapper: userWrapper }
    const hash = (wrapperText: string, cron = job.cron) => taskDescriptionHash(renderTaskXml({ ...job, cron, fields: parseCronFields(cron)! }, triggers(cron), { ...options, wrapperText }))
    expect(hash("a")).toMatch(/^[0-9a-f]{64}$/)
    expect(hash("a")).toBe(hash("a"))
    expect(hash("b")).not.toBe(hash("a"))
    expect(hash("a", "0 */2 * * *")).not.toBe(hash("a"))
  })
})

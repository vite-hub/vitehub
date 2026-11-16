import { describe, expect, it } from "vitest"

import { osScheduleErrors } from "../src/os/errors.ts"
import { generatedHeader } from "../src/os/host.ts"
import { createOsSchedules } from "../src/os/schedules.ts"

import type { ExecResult, OsHost } from "../src/os/host.ts"
import type { InstallOsScheduleOptions } from "../src/os/schedules.ts"

interface Call {
  command: string
  env?: Record<string, string>
}

/** A machine in memory. `respond` answers each command; the default answer is success with no output. */
function fakeHost(platform: string, respond: (command: string, args: readonly string[]) => Partial<ExecResult> | undefined = () => undefined, overrides: Partial<OsHost> = {}) {
  const files = new Map<string, string>()
  const directories = new Set<string>()
  const calls: Call[] = []
  const host: OsHost = {
    platform,
    uid: 1000,
    user: "maxi",
    homedir: "/home/maxi",
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    machineTimeZone: "UTC",
    now: () => new Date("2026-11-16T15:23:30Z"),
    sleep: async () => {},
    async exec(file, args, env) {
      const command = [file, ...args].join(" ")
      calls.push({ command, ...(env ? { env } : {}) })
      return { code: 0, stdout: "", stderr: "", ...respond(command, args) }
    },
    fs: {
      readFile: async path => files.get(path),
      writeFile: async (path, content) => {
        files.set(path, content)
      },
      mkdir: async (path) => {
        directories.add(path)
      },
      rm: async path => files.delete(path),
      rmdirIfEmpty: async (path) => {
        if (![...files.keys()].some(file => file.startsWith(`${path}/`) || file.startsWith(`${path}\\`))) directories.delete(path)
      },
    },
    ...overrides,
  }
  return { host, files, directories, calls, commands: () => calls.splice(0).map(call => call.command) }
}

const command: InstallOsScheduleOptions["command"] = ["/usr/bin/node", "/home/maxi/skync/bin.mjs", "sync"]

// `systemctl --user show vitehub-os-capture.timer vitehub-os-capture.service --timestamp=unix -p ...` on systemd 259,
// captured on a real machine, before the first run, during a run, and after a run that exited with code 3.
const showBefore = `Id=skync.timer
LoadState=loaded
FragmentPath=/home/maxi/.config/systemd/user/skync.timer
ActiveState=active
SubState=waiting
NextElapseUSecRealtime=@1794842700
LastTriggerUSec=
Result=success

Id=skync.service
LoadState=loaded
FragmentPath=/home/maxi/.config/systemd/user/skync.service
ActiveState=inactive
SubState=dead
Result=success
ExecMainStartTimestamp=
ExecMainExitTimestamp=
ExecMainCode=0
ExecMainStatus=0
`
const showRunning = `Id=skync.timer
LoadState=loaded
FragmentPath=/home/maxi/.config/systemd/user/skync.timer
ActiveState=active
SubState=running
NextElapseUSecRealtime=
LastTriggerUSec=@1794842700
Result=success

Id=skync.service
LoadState=loaded
FragmentPath=/home/maxi/.config/systemd/user/skync.service
ActiveState=activating
SubState=start
Result=success
ExecMainStartTimestamp=@1794842700
ExecMainExitTimestamp=
ExecMainCode=0
ExecMainStatus=0
`
const showAfter = `Id=skync.timer
LoadState=loaded
FragmentPath=/home/maxi/.config/systemd/user/skync.timer
ActiveState=active
SubState=waiting
NextElapseUSecRealtime=@1794842760
LastTriggerUSec=@1794842700
Result=success

Id=skync.service
LoadState=loaded
FragmentPath=/home/maxi/.config/systemd/user/skync.service
ActiveState=failed
SubState=failed
Result=exit-code
ExecMainStartTimestamp=@1794842700
ExecMainExitTimestamp=@1794842720
ExecMainCode=1
ExecMainStatus=3
`
const showMissing = `Id=skync.timer
LoadState=not-found
FragmentPath=
ActiveState=inactive
SubState=dead
NextElapseUSecRealtime=
LastTriggerUSec=
Result=success

Id=skync.service
LoadState=not-found
FragmentPath=
ActiveState=inactive
SubState=dead
Result=success
ExecMainStartTimestamp=
ExecMainExitTimestamp=
ExecMainCode=0
ExecMainStatus=0
`

/** A systemd that remembers whether the timer is enabled and active. */
function systemd(overrides: Partial<OsHost> = {}) {
  let enabled = false
  let show = showMissing
  const machine = fakeHost("linux", (line) => {
    if (/ enable (--now )?skync\.timer$/.test(line)) enabled = true
    if (line.endsWith(" disable --now skync.timer")) enabled = false
    if (line.endsWith("is-enabled skync.timer")) return enabled ? { stdout: "enabled\n" } : { code: 1, stdout: "disabled\n" }
    if (line.endsWith("is-active skync.timer")) return enabled ? { stdout: "active\n" } : { code: 3, stdout: "inactive\n" }
    if (line.startsWith("loginctl show-user maxi")) return { stdout: "yes\n" }
    if (line.includes(" show skync.timer skync.service ")) return { stdout: show }
    return undefined
  }, overrides)
  return { ...machine, setShow: (output: string) => {
    show = output
  } }
}

describe("systemd driver", () => {
  const service = "/home/maxi/.config/systemd/user/skync.service"
  const timer = "/home/maxi/.config/systemd/user/skync.timer"

  it("writes the units, enables the timer, and changes nothing on a second install", async () => {
    const machine = systemd()
    const { installOsSchedule } = createOsSchedules(machine.host)
    const [error, unit] = await installOsSchedule("skync", { cron: "0 9 * * 1-5", timeZone: "Europe/Madrid" }, { command })
    expect(error).toBeUndefined()
    expect(unit).toMatchObject({ name: "skync", platform: "linux", scope: "user", files: [service, timer], changed: true, linger: true })
    expect(machine.files.get(timer)).toContain("OnCalendar=Mon..Fri *-*-* 09:00:00 Europe/Madrid\n")
    expect(machine.files.get(service)).toContain("WorkingDirectory=/home/maxi\n")
    expect(machine.commands()).toEqual([
      "systemctl --user show skync.service skync.timer -p Id,LoadState,FragmentPath",
      "systemctl --user daemon-reload",
      "systemctl --user enable skync.timer",
      "systemctl --user restart skync.timer",
      "systemctl --user is-enabled skync.timer",
      "systemctl --user is-active skync.timer",
      "loginctl show-user maxi -p Linger --value",
    ])

    const [, again] = await installOsSchedule("skync", { cron: "0 9 * * 1-5", timeZone: "Europe/Madrid" }, { command })
    expect(again?.changed).toBe(false)
    expect(machine.commands()).toEqual(["systemctl --user show skync.service skync.timer -p Id,LoadState,FragmentPath", "systemctl --user is-enabled skync.timer", "systemctl --user is-active skync.timer", "loginctl show-user maxi -p Linger --value"])

    const [, changed] = await installOsSchedule("skync", { cron: "0 10 * * 1-5", timeZone: "Europe/Madrid" }, { command })
    expect(changed?.changed).toBe(true)
    expect(machine.files.get(timer)).toContain("OnCalendar=Mon..Fri *-*-* 10:00:00 Europe/Madrid\n")
    expect(machine.commands()).toContain("systemctl --user restart skync.timer")
  })

  it("starts a timer that someone disabled, and reports the change", async () => {
    const machine = systemd()
    const { installOsSchedule } = createOsSchedules(machine.host)
    await installOsSchedule("skync", { cron: "0 * * * *" }, { command })
    await machine.host.exec("systemctl", ["--user", "disable", "--now", "skync.timer"])
    machine.commands()
    const [, unit] = await installOsSchedule("skync", { cron: "0 * * * *" }, { command })
    expect(unit?.changed).toBe(true)
    expect(machine.commands()).toContain("systemctl --user enable --now skync.timer")
  })

  it("reads the status of systemctl show", async () => {
    const machine = systemd()
    const { osScheduleStatus } = createOsSchedules(machine.host)
    expect((await osScheduleStatus("skync"))[1]).toEqual({ name: "skync", platform: "linux", scope: "user", installed: false, running: false, linger: true })
    machine.setShow(showBefore)
    expect((await osScheduleStatus("skync"))[1]).toEqual({ name: "skync", platform: "linux", scope: "user", installed: true, running: false, nextRunAt: new Date("2026-11-16T15:25:00Z"), linger: true })
    machine.setShow(showRunning)
    expect((await osScheduleStatus("skync"))[1]).toEqual({ name: "skync", platform: "linux", scope: "user", installed: true, running: true, lastRunAt: new Date("2026-11-16T15:25:00Z"), linger: true })
    machine.setShow(showAfter)
    expect((await osScheduleStatus("skync"))[1]).toEqual({ name: "skync", platform: "linux", scope: "user", installed: true, running: false, lastRunAt: new Date("2026-11-16T15:25:00Z"), lastExitCode: 3, nextRunAt: new Date("2026-11-16T15:26:00Z"), linger: true })
    expect(machine.commands()[0]).toBe("systemctl --user show skync.timer skync.service --timestamp=unix -p Id,LoadState,FragmentPath,ActiveState,SubState,NextElapseUSecRealtime,LastTriggerUSec,ExecMainStartTimestamp,ExecMainExitTimestamp,ExecMainCode,ExecMainStatus,Result")
  })

  it("removes the units and the log file, and succeeds when nothing is installed", async () => {
    const machine = systemd()
    const { installOsSchedule, uninstallOsSchedule } = createOsSchedules(machine.host)
    const [, unit] = await installOsSchedule("skync", { cron: "0 * * * *" }, { command, logDir: "/home/maxi/.local/state/skync" })
    expect(unit?.files).toEqual([service, timer, "/home/maxi/.local/state/skync/skync.log"])
    machine.files.set("/home/maxi/.local/state/skync/skync.log", "out\n")
    machine.commands()
    const [, removal] = await unit!.uninstall()
    expect(removal).toEqual({ name: "skync", platform: "linux", scope: "user", removed: [timer, service, "/home/maxi/.local/state/skync/skync.log"], existed: true })
    expect([...machine.files.keys()]).toEqual([])
    expect(machine.commands()).toEqual([
      "systemctl --user show skync.service skync.timer -p Id,LoadState,FragmentPath",
      "systemctl --user disable --now skync.timer",
      "systemctl --user stop skync.service",
      "systemctl --user clean --what=state skync.timer",
      "systemctl --user daemon-reload",
      "systemctl --user reset-failed skync.service skync.timer",
    ])
    expect((await uninstallOsSchedule("skync"))[1]).toEqual({ name: "skync", platform: "linux", scope: "user", removed: [], existed: false })
    expect(machine.commands()).toEqual([])
  })

  it("writes system units as root, and needs root for them", async () => {
    const user = createOsSchedules(systemd().host)
    const [error] = await user.installOsSchedule("skync", { cron: "0 * * * *" }, { command, scope: "system" })
    expect(osScheduleErrors.SCHEDULE_OS_PERMISSION_REQUIRED.is(error)).toBe(true)

    const machine = systemd({ uid: 0 })
    const [, unit] = await createOsSchedules(machine.host).installOsSchedule("skync", { cron: "0 * * * *" }, { command, scope: "system" })
    expect(unit).toMatchObject({ scope: "system", files: ["/etc/systemd/system/skync.service", "/etc/systemd/system/skync.timer"] })
    expect(unit).not.toHaveProperty("linger")
    expect(machine.commands()).toContain("systemctl enable skync.timer")
  })

  it("finds the user manager when XDG_RUNTIME_DIR is not set", async () => {
    const machine = systemd({ env: {} })
    await createOsSchedules(machine.host).osScheduleStatus("skync")
    expect(machine.calls[0]?.env).toEqual({ XDG_RUNTIME_DIR: "/run/user/1000" })
  })

  it("returns the systemctl error", async () => {
    const machine = fakeHost("linux", line => line.endsWith("daemon-reload") ? { code: 1, stderr: "Failed to connect to bus: No medium found\n" } : undefined)
    const [error] = await createOsSchedules(machine.host).installOsSchedule("skync", { cron: "0 * * * *" }, { command })
    expect(osScheduleErrors.SCHEDULE_OS_COMMAND_FAILED.is(error)).toBe(true)
    expect(error?.data).toEqual({ command: "systemctl --user daemon-reload", exitCode: 1, output: "Failed to connect to bus: No medium found" })
  })
})

// `launchctl print gui/501/skync` on macOS 15 after one run.
const launchctlPrint = `gui/501/skync = {
\tactive count = 0
\tpath = /Users/maxi/Library/LaunchAgents/skync.plist
\ttype = LaunchAgent
\tstate = not running

\tprogram = /usr/local/bin/node
\targuments = {
\t\t/usr/local/bin/node
\t\t/Users/maxi/skync/bin.mjs
\t\tsync
\t}

\tstdout path = /Users/maxi/Library/Logs/skync/skync.log
\tstderr path = /Users/maxi/Library/Logs/skync/skync.log
\tdefault environment = {
\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin
\t}

\tenvironment = {
\t\tXPC_SERVICE_NAME => skync
\t}

\tdomain = gui/501 [100006]
\tasid = 100006
\tminimum runtime = 10
\texit timeout = 5
\truns = 1
\tlast exit code = 0

\tevent triggers = {
\t\tskync.268435460 => {
\t\t\tkeepalive = 0
\t\t\tservice = skync
\t\t\tstream = com.apple.launchd.calendarinterval.system
\t\t\tmonitor = 0
\t\t\tdescriptor = {
\t\t\t\t"Minute" => 0
\t\t\t}
\t\t}
\t}

\tevent channels = {
\t\t"com.apple.launchd.calendarinterval.system" = {
\t\t\tport = 0x0
\t\t\tactive = 0
\t\t\tmanaged = 1
\t\t\treset = 0
\t\t\thide = 0
\t\t\twatching = 1
\t\t}
\t}

\tspawn type = background (4)
\tjetsam priority = 40
\tproperties = runatload | inferred program
}
`

function launchd(overrides: Partial<OsHost> = {}, respond: (line: string) => Partial<ExecResult> | undefined = () => undefined) {
  const loaded = new Set<string>()
  return fakeHost("darwin", (line, args) => {
    const answer = respond(line)
    if (answer) return answer
    if (args[0] === "print") return loaded.has(args[1]!) ? { stdout: launchctlPrint.replaceAll("gui/501", args[1]!.split("/").slice(0, 2).join("/")) } : { code: 113, stderr: `Could not find service "skync" in domain for user gui: 501\n` }
    if (args[0] === "bootstrap") loaded.add(`${args[1]}/skync`)
    if (args[0] === "bootout") loaded.delete(args[1]!)
    return undefined
  }, { uid: 501, user: "maxi", homedir: "/Users/maxi", machineTimeZone: "Europe/Madrid", ...overrides })
}

describe("launchd driver", () => {
  const plist = "/Users/maxi/Library/LaunchAgents/skync.plist"
  const logFile = "/Users/maxi/Library/Logs/skync/skync.log"

  it("bootstraps a LaunchAgent, and changes nothing on a second install", async () => {
    const machine = launchd()
    const { installOsSchedule } = createOsSchedules(machine.host)
    const [error, unit] = await installOsSchedule("skync", { cron: "0 9 * * 1-5", timeZone: "Europe/Madrid" }, { command })
    expect(error).toBeUndefined()
    expect(unit).toMatchObject({ platform: "darwin", scope: "user", files: [plist, logFile], changed: true })
    expect(machine.files.get(plist)).toContain("<key>Weekday</key>")
    expect(machine.directories).toEqual(new Set(["/Users/maxi/Library/Logs/skync"]))
    expect(machine.commands()).toEqual([
      "launchctl print gui/501/skync",
      "launchctl print user/501/skync",
      `launchctl bootstrap gui/501 ${plist}`,
      "launchctl enable gui/501/skync",
    ])

    const [, again] = await installOsSchedule("skync", { cron: "0 9 * * 1-5", timeZone: "Europe/Madrid" }, { command })
    expect(again?.changed).toBe(false)
    expect(machine.commands()).toEqual(["launchctl print gui/501/skync"])

    const [, changed] = await installOsSchedule("skync", { cron: "30 9 * * 1-5", timeZone: "Europe/Madrid" }, { command })
    expect(changed?.changed).toBe(true)
    expect(machine.commands()).toEqual([
      "launchctl print gui/501/skync",
      "launchctl bootout gui/501/skync",
      `launchctl bootstrap gui/501 ${plist}`,
      "launchctl enable gui/501/skync",
    ])
  })

  it("falls back to the user domain without a login session, and retries a bootstrap during a bootout", async () => {
    let busy = 1
    const machine = launchd({}, (line) => {
      if (line.startsWith("launchctl bootstrap gui/501")) return { code: 125, stderr: "Bootstrap failed: 125: Domain does not support specified action\n" }
      if (line.startsWith("launchctl bootstrap user/501") && busy-- > 0) return { code: 5, stderr: "Bootstrap failed: 5: Input/output error\n" }
      return undefined
    })
    const [, unit] = await createOsSchedules(machine.host).installOsSchedule("skync", { cron: "0 * * * *" }, { command })
    expect(unit?.changed).toBe(true)
    expect(machine.commands().slice(2)).toEqual([
      `launchctl bootstrap gui/501 ${plist}`,
      `launchctl bootstrap user/501 ${plist}`,
      `launchctl bootstrap user/501 ${plist}`,
      "launchctl enable user/501/skync",
    ])
  })

  it("reads the status of launchctl print, and computes the next run from the plist", async () => {
    const machine = launchd()
    const { installOsSchedule, osScheduleStatus } = createOsSchedules(machine.host)
    await installOsSchedule("skync", { cron: "0 * * * *" }, { command })
    expect((await osScheduleStatus("skync"))[1]).toEqual({ name: "skync", platform: "darwin", scope: "user", installed: true, running: false, lastExitCode: 0, nextRunAt: new Date("2026-11-16T16:00:00Z"), logFile })
  })

  it("removes the plist, the log file, and the default log folder", async () => {
    const machine = launchd()
    const { installOsSchedule, osScheduleStatus } = createOsSchedules(machine.host)
    const [, unit] = await installOsSchedule("skync", { cron: "0 * * * *" }, { command })
    machine.files.set(logFile, "ran\n")
    machine.commands()
    expect((await unit!.uninstall())[1]).toEqual({ name: "skync", platform: "darwin", scope: "user", removed: [plist, logFile], existed: true })
    expect(machine.commands()).toEqual(["launchctl print gui/501/skync", "launchctl bootout gui/501/skync"])
    expect(machine.files.size).toBe(0)
    expect(machine.directories.size).toBe(0)
    expect((await osScheduleStatus("skync"))[1]).toEqual({ name: "skync", platform: "darwin", scope: "user", installed: false, running: false })
  })

  it.each([
    [{ catchUp: false }, "catchUp"],
    [{ randomDelaySeconds: 30 }, "randomDelaySeconds"],
  ])("rejects %j", async (options, option) => {
    const [error] = await createOsSchedules(launchd().host).installOsSchedule("skync", { cron: "0 * * * *" }, { command, ...options })
    expect(osScheduleErrors.SCHEDULE_OS_OPTION_UNSUPPORTED.is(error) && error.data).toMatchObject({ platform: "darwin", option })
  })

  it("rejects a daily cron in another zone than the machine's, and too many dicts", async () => {
    const { installOsSchedule } = createOsSchedules(launchd().host)
    const [zoneError] = await installOsSchedule("skync", { cron: "0 9 * * *" }, { command })
    expect(osScheduleErrors.SCHEDULE_OS_TIME_ZONE_UNSUPPORTED.is(zoneError) && zoneError.data).toEqual({ platform: "darwin", timeZone: "UTC", machineTimeZone: "Europe/Madrid" })
    const [cronError] = await installOsSchedule("skync", { cron: "0-58 0-22 * * *", timeZone: "Europe/Madrid" }, { command })
    expect(osScheduleErrors.SCHEDULE_OS_CRON_UNSUPPORTED.is(cronError)).toBe(true)
  })
})

function decode(args: readonly string[]): string {
  return Buffer.from(args.at(-1)!, "base64").toString("utf16le")
}

/** Task Scheduler behind powershell.exe: the scripts register, read, and remove one task. */
function taskScheduler(overrides: Partial<OsHost> = {}) {
  let task: { description: string, state: string } | undefined
  let info = ""
  const scripts: string[] = []
  const machine = fakeHost("win32", (_line, args) => {
    const script = decode(args)
    scripts.push(script)
    if (script.includes("Register-ScheduledTask")) {
      const xml = machine.files.get("C:\\Users\\maxi\\AppData\\Local\\ViteHub\\schedules\\skync.xml")!
      task = { description: /<Description>(.*)<\/Description>/.exec(xml)![1]!, state: "Ready" }
      return undefined
    }
    if (script.includes("Unregister-ScheduledTask")) {
      const existed = task !== undefined
      task = undefined
      return { stdout: existed ? "removed\r\n" : "missing\r\n" }
    }
    if (script.includes("Get-ScheduledTaskInfo")) return { stdout: info || (task ? JSON.stringify({ installed: true, state: task.state, description: task.description, lastRunTime: null, lastTaskResult: 267011, nextRunTime: "2026-11-16T16:00:00.0000000Z" }) : "{\"installed\":false}") }
    return undefined
  }, { uid: undefined, user: "DESKTOP-1\\maxi", homedir: "C:\\Users\\maxi", env: { LOCALAPPDATA: "C:\\Users\\maxi\\AppData\\Local" }, ...overrides })
  return { ...machine, scripts, disable: () => {
    task!.state = "Disabled"
  }, setTask: (description: string) => {
    task = { description, state: "Ready" }
  }, setInfo: (output: string) => {
    info = output
  } }
}

describe("Task Scheduler driver", () => {
  const wrapper = "C:\\Users\\maxi\\AppData\\Local\\ViteHub\\schedules\\skync.ps1"
  const logFile = "C:\\Users\\maxi\\AppData\\Local\\skync\\Logs\\skync.log"
  const windowsCommand: InstallOsScheduleOptions["command"] = ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\maxi\\skync\\bin.mjs", "sync"]

  it("registers the task from an XML file, and changes nothing on a second install", async () => {
    const machine = taskScheduler()
    const { installOsSchedule } = createOsSchedules(machine.host)
    const [error, unit] = await installOsSchedule("skync", { cron: "*/15 * * * *" }, { command: windowsCommand })
    expect(error).toBeUndefined()
    expect(unit).toMatchObject({ platform: "win32", scope: "user", files: [wrapper, logFile], changed: true })
    expect([...machine.files.keys()]).toEqual([wrapper])
    expect(machine.files.get(wrapper)).toContain("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\maxi\\skync\\bin.mjs' 'sync' 2>&1")
    expect(machine.directories).toEqual(new Set(["C:\\Users\\maxi\\AppData\\Local\\skync\\Logs"]))
    expect(machine.calls.every(call => call.command.startsWith("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "))).toBe(true)
    expect(machine.scripts.at(-1)).toContain("Register-ScheduledTask -TaskName 'skync' -TaskPath '\\' -Xml $xml -Force")

    machine.scripts.length = 0
    const [, again] = await installOsSchedule("skync", { cron: "*/15 * * * *" }, { command: windowsCommand })
    expect(again?.changed).toBe(false)
    expect(machine.scripts.some(script => script.includes("Register-ScheduledTask"))).toBe(false)

    const [, changed] = await installOsSchedule("skync", { cron: "*/30 * * * *" }, { command: windowsCommand })
    expect(changed?.changed).toBe(true)
    expect(machine.scripts.at(-1)).toContain("Register-ScheduledTask")

    machine.disable()
    const [, enabled] = await installOsSchedule("skync", { cron: "*/30 * * * *" }, { command: windowsCommand })
    expect(enabled?.changed).toBe(true)
  })

  it("reads the status JSON of Get-ScheduledTaskInfo", async () => {
    const ours = `skync (ViteHub schedule). Managed by ViteHub (user scope). sha256:${"0".repeat(64)}`
    const machine = taskScheduler()
    const { installOsSchedule, osScheduleStatus } = createOsSchedules(machine.host)
    await installOsSchedule("skync", { cron: "* * * * *" }, { command: windowsCommand })
    expect((await osScheduleStatus("skync"))[1]).toEqual({ name: "skync", platform: "win32", scope: "user", installed: true, running: false, nextRunAt: new Date("2026-11-16T16:00:00Z"), logFile })
    machine.setInfo(`{"lastTaskResult":1,"nextRunTime":"2026-11-16T15:25:00.0000000Z","installed":true,"description":"${ours}","state":"Ready","lastRunTime":"2026-11-16T15:24:00.5310000Z"}\r\n`)
    expect((await osScheduleStatus("skync"))[1]).toEqual({ name: "skync", platform: "win32", scope: "user", installed: true, running: false, lastRunAt: new Date("2026-11-16T15:24:00.531Z"), lastExitCode: 1, nextRunAt: new Date("2026-11-16T15:25:00Z"), logFile })
    machine.setInfo(`{"lastTaskResult":267009,"nextRunTime":null,"installed":true,"description":"${ours}","state":"Running","lastRunTime":"2026-11-16T15:25:00.1000000Z"}`)
    expect((await osScheduleStatus("skync"))[1]).toEqual({ name: "skync", platform: "win32", scope: "user", installed: true, running: true, lastRunAt: new Date("2026-11-16T15:25:00.1Z"), logFile })
  })

  it("unregisters the task and removes the wrapper and the log file", async () => {
    const machine = taskScheduler()
    const { installOsSchedule, uninstallOsSchedule } = createOsSchedules(machine.host)
    const [, unit] = await installOsSchedule("skync", { cron: "0 * * * *" }, { command: windowsCommand })
    machine.files.set(logFile, "ran\n")
    expect((await unit!.uninstall())[1]).toEqual({ name: "skync", platform: "win32", scope: "user", removed: [wrapper, logFile], existed: true })
    expect(machine.files.size).toBe(0)
    expect(machine.directories.size).toBe(0)
    expect((await uninstallOsSchedule("skync"))[1]).toEqual({ name: "skync", platform: "win32", scope: "user", removed: [], existed: false })
  })

  it("returns PERMISSION_REQUIRED when Windows denies access", async () => {
    const machine = fakeHost("win32", (_line, args) => decode(args).includes("Register-ScheduledTask") ? { code: 1, stderr: "Register-ScheduledTask : Access is denied.\r\n" } : { stdout: "{\"installed\":false}" }, { uid: undefined, env: { ProgramData: "C:\\ProgramData" } })
    const [error] = await createOsSchedules(machine.host).installOsSchedule("skync", { cron: "0 * * * *" }, { command: windowsCommand, scope: "system" })
    expect(osScheduleErrors.SCHEDULE_OS_PERMISSION_REQUIRED.is(error) && error.data).toEqual({ scope: "system" })
    expect(machine.files.size).toBe(0)
  })

  it.each([
    ["C:\\Program Files\\app\\", "spaces that ends with a backslash"],
    ["say \"hi\"", "double quote"],
    ["", "empty argument"],
  ])("rejects the argument %j", async (argument, reason) => {
    const [error] = await createOsSchedules(taskScheduler().host).installOsSchedule("skync", { cron: "0 * * * *" }, { command: ["C:\\app.exe", argument] })
    expect(osScheduleErrors.SCHEDULE_OS_OPTION_UNSUPPORTED.is(error) && error.data.reason).toContain(reason)
  })

  it("rejects a weekday list in some months", async () => {
    const [error] = await createOsSchedules(taskScheduler().host).installOsSchedule("skync", { cron: "0 9 * 1-6 1" }, { command: windowsCommand })
    expect(osScheduleErrors.SCHEDULE_OS_CRON_UNSUPPORTED.is(error) && error.data.platform).toBe("win32")
  })
})

describe("options", () => {
  const install = (name: string, schedule: object, options: object, platform = "linux") => createOsSchedules(systemd({ platform }).host).installOsSchedule(name, schedule, options as InstallOsScheduleOptions)

  it.each([
    ["-skync", { cron: "0 * * * *" }, { command }, "the name"],
    ["sky/nc", { cron: "0 * * * *" }, { command }, "the name"],
    ["skync", {}, { command }, "pass a Schedule with `cron`"],
    ["skync", { cron: "0 * * * * *" }, { command }, "five-field"],
    ["skync", { cron: "0 * * * *", timeZone: "Mars/Olympus" }, { command }, "IANA"],
    ["skync", { cron: "0 * * * *" }, { command, every: "hour" }, "`every` is not an option"],
    ["skync", { cron: "0 * * * *" }, { command: ["node", "bin.mjs"] }, "absolute path"],
    ["skync", { cron: "0 * * * *" }, { command: [] }, "list of strings"],
    ["skync", { cron: "0 * * * *" }, { command, scope: "global" }, "`scope`"],
    ["skync", { cron: "0 * * * *" }, { command, env: { "BAD-NAME": "1" } }, "invalid variable name"],
    ["skync", { cron: "0 * * * *" }, { command, env: { TOKEN: "a\nExecStartPre=/bin/false" } }, "one line"],
    ["skync", { cron: "0 * * * *" }, { command, cwd: "srv" }, "`cwd` must be an absolute path"],
    ["skync", { cron: "0 * * * *" }, { command, randomDelaySeconds: 1.5 }, "randomDelaySeconds"],
  ])("rejects %j %j %j", async (name, schedule, options, problem) => {
    const [error] = await install(name, schedule, options)
    expect(osScheduleErrors.SCHEDULE_OS_INVALID_OPTIONS.is(error) && error.data.problem).toContain(problem)
  })

  it("accepts a Windows path on Windows only", async () => {
    const [error] = await install("skync", { cron: "0 * * * *" }, { command: ["C:\\node.exe"] })
    expect(osScheduleErrors.SCHEDULE_OS_INVALID_OPTIONS.is(error)).toBe(true)
    const [windowsError] = await createOsSchedules(taskScheduler().host).installOsSchedule("skync", { cron: "0 * * * *" }, { command: ["C:\\node.exe"] })
    expect(windowsError).toBeUndefined()
  })

  it("rejects an unsupported platform", async () => {
    const { installOsSchedule, osScheduleStatus } = createOsSchedules(fakeHost("freebsd").host)
    const [error] = await installOsSchedule("skync", { cron: "0 * * * *" }, { command })
    expect(osScheduleErrors.SCHEDULE_OS_PLATFORM_UNSUPPORTED.is(error) && error.data).toEqual({ platform: "freebsd" })
    expect(osScheduleErrors.SCHEDULE_OS_PLATFORM_UNSUPPORTED.is((await osScheduleStatus("skync"))[0])).toBe(true)
  })

  it("takes a defineSchedule() result", async () => {
    const { defineSchedule } = await import("../src/definition.ts")
    const [error, unit] = await install("skync", defineSchedule({ cron: "0 9 * * *", timeZone: "Europe/Madrid", handler: () => {} }), { command })
    expect(error).toBeUndefined()
    expect(unit?.files).toHaveLength(2)
  })
})

describe("a name that ViteHub did not install", () => {
  const service = "/home/maxi/.config/systemd/user/skync.service"
  const timer = "/home/maxi/.config/systemd/user/skync.timer"
  const handMade = "[Unit]\nDescription=My own job\n\n[Service]\nType=oneshot\nExecStart=/bin/true\n"

  it("systemd: leaves a unit file without the ViteHub header at our path", async () => {
    const machine = systemd()
    machine.setShow(showBefore)
    machine.files.set(service, handMade)
    const { installOsSchedule, osScheduleStatus, uninstallOsSchedule } = createOsSchedules(machine.host)
    const [error] = await installOsSchedule("skync", { cron: "0 * * * *" }, { command })
    expect(osScheduleErrors.SCHEDULE_OS_NAME_TAKEN.is(error) && error.data).toEqual({ platform: "linux", name: "skync", scope: "user", resource: service })
    expect(machine.commands()).toEqual([])
    expect((await uninstallOsSchedule("skync"))[1]).toEqual({ name: "skync", platform: "linux", scope: "user", removed: [], existed: false })
    expect(machine.commands()).toEqual([])
    expect((await osScheduleStatus("skync"))[1]).toEqual({ name: "skync", platform: "linux", scope: "user", installed: false, running: false, linger: true })
    expect([...machine.files]).toEqual([[service, handMade]])
  })

  it("systemd: leaves a unit that systemd loads from another directory", async () => {
    const elsewhere = `Id=skync.service\nLoadState=loaded\nFragmentPath=/usr/lib/systemd/user/skync.service\n\nId=skync.timer\nLoadState=not-found\nFragmentPath=\n`
    const machine = fakeHost("linux", line => line.includes(" show skync.service skync.timer -p Id,LoadState,FragmentPath") ? { stdout: elsewhere } : undefined)
    const { installOsSchedule } = createOsSchedules(machine.host)
    const [error] = await installOsSchedule("skync", { cron: "0 * * * *" }, { command })
    expect(osScheduleErrors.SCHEDULE_OS_NAME_TAKEN.is(error) && error.data).toEqual({ platform: "linux", name: "skync", scope: "user", resource: "/usr/lib/systemd/user/skync.service" })
    expect(machine.files.size).toBe(0)
    expect(machine.commands()).toEqual(["systemctl --user show skync.service skync.timer -p Id,LoadState,FragmentPath"])
  })

  it("systemd: does not stop a unit of another file that shadows our files", async () => {
    // A transient unit, as `systemd-run --user --unit=skync` makes, wins over ~/.config/systemd/user.
    const transient = "/run/user/1000/systemd/transient/skync.service"
    const show = (properties: string) => `Id=skync.timer\nLoadState=loaded\nFragmentPath=${timer}\n${properties}\nId=skync.service\nLoadState=loaded\nFragmentPath=${transient}\nActiveState=active\n`
    const machine = fakeHost("linux", line => line.includes(" show ") ? { stdout: show("") } : undefined)
    const ours = `# ${generatedHeader}\n[Unit]\n`
    machine.files.set(service, ours)
    machine.files.set(timer, ours)
    const { osScheduleStatus, uninstallOsSchedule } = createOsSchedules(machine.host)
    expect((await uninstallOsSchedule("skync"))[1]).toEqual({ name: "skync", platform: "linux", scope: "user", removed: [], existed: false })
    expect(machine.commands()).toEqual(["systemctl --user show skync.service skync.timer -p Id,LoadState,FragmentPath"])
    expect(machine.files.size).toBe(2)
    expect((await osScheduleStatus("skync"))[1]).toMatchObject({ installed: false, running: false })
  })

  it("launchd: leaves a plist without the ViteHub header", async () => {
    const plist = "/Users/maxi/Library/LaunchAgents/skync.plist"
    const machine = launchd()
    machine.files.set(plist, "<plist><dict><key>Label</key><string>skync</string></dict></plist>")
    const { installOsSchedule, uninstallOsSchedule } = createOsSchedules(machine.host)
    const [error] = await installOsSchedule("skync", { cron: "0 * * * *" }, { command })
    expect(osScheduleErrors.SCHEDULE_OS_NAME_TAKEN.is(error) && error.data).toEqual({ platform: "darwin", name: "skync", scope: "user", resource: plist })
    expect((await uninstallOsSchedule("skync"))[1]).toEqual({ name: "skync", platform: "darwin", scope: "user", removed: [], existed: false })
    expect(machine.commands().every(line => line.startsWith("launchctl print "))).toBe(true)
    expect(machine.files.get(plist)).toBe("<plist><dict><key>Label</key><string>skync</string></dict></plist>")
  })

  it("launchd: leaves a job with our label that launchd loaded from another plist", async () => {
    const other = "/Users/maxi/Library/LaunchAgents/com.example.skync.plist"
    const machine = launchd({}, line => line === "launchctl print gui/501/skync" ? { stdout: launchctlPrint.replace("/Users/maxi/Library/LaunchAgents/skync.plist", other) } : undefined)
    const { installOsSchedule, osScheduleStatus, uninstallOsSchedule } = createOsSchedules(machine.host)
    const [error] = await installOsSchedule("skync", { cron: "0 * * * *" }, { command })
    expect(osScheduleErrors.SCHEDULE_OS_NAME_TAKEN.is(error) && error.data).toEqual({ platform: "darwin", name: "skync", scope: "user", resource: other })
    expect(machine.files.size).toBe(0)
    expect((await uninstallOsSchedule("skync"))[1]).toEqual({ name: "skync", platform: "darwin", scope: "user", removed: [], existed: false })
    expect((await osScheduleStatus("skync"))[1]).toEqual({ name: "skync", platform: "darwin", scope: "user", installed: false, running: false })
    expect(machine.commands()).toEqual(["launchctl print gui/501/skync", "launchctl print gui/501/skync", "launchctl print gui/501/skync"])
  })

  const windowsCommand: InstallOsScheduleOptions["command"] = ["C:\\node.exe", "C:\\skync\\bin.mjs"]

  it.each([
    ["a task without the ViteHub marker", "Backs up my photos", "user", "the task \\skync"],
    ["a system task", `skync (ViteHub schedule). Managed by ViteHub (system scope). sha256:${"0".repeat(64)}`, "user", "the system-scope task \\skync"],
    ["a user task", `skync (ViteHub schedule). Managed by ViteHub (user scope). sha256:${"0".repeat(64)}`, "system", "the user-scope task \\skync"],
  ] as const)("Task Scheduler: leaves %s", async (_, description, scope, resource) => {
    const machine = taskScheduler({ env: { LOCALAPPDATA: "C:\\Users\\maxi\\AppData\\Local", ProgramData: "C:\\ProgramData" } })
    machine.setTask(description)
    const { installOsSchedule, osScheduleStatus, uninstallOsSchedule } = createOsSchedules(machine.host)
    const [error] = await installOsSchedule("skync", { cron: "0 * * * *" }, { command: windowsCommand, scope })
    expect(osScheduleErrors.SCHEDULE_OS_NAME_TAKEN.is(error) && error.data).toEqual({ platform: "win32", name: "skync", scope, resource })
    expect((await uninstallOsSchedule("skync", { scope }))[1]).toEqual({ name: "skync", platform: "win32", scope, removed: [], existed: false })
    expect((await osScheduleStatus("skync", { scope }))[1]).toEqual({ name: "skync", platform: "win32", scope, installed: false, running: false })
    expect(machine.scripts.some(script => /\b(?:Unr|R)egister-ScheduledTask\b/.test(script))).toBe(false)
    expect(machine.files.size).toBe(0)
  })
})

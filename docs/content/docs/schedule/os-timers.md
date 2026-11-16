---
title: Run a Schedule from the OS timer
description: Install a Schedule as a systemd timer, a launchd job, or a Windows scheduled task, so the operating system starts your command at each time.
navigation.title: OS timers
navigation.order: 7
icon: i-lucide-alarm-clock
---

A CLI or a desktop tool has no server that stays on. `@vite-hub/schedule/os` gives the cron of a Schedule to the timer of the operating system. The operating system then starts your command at each time, also when your tool is not open.

```bash pm [commands/install]
pnpm add @vite-hub/schedule
```

This CLI syncs photos every hour. `photo-sync install` installs the timer. The timer runs `photo-sync sync`.

```ts [src/cli.ts]
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineSchedule } from '@vite-hub/schedule'
import { executeStaticSchedule } from '@vite-hub/schedule/runtime'
import { installOsSchedule } from '@vite-hub/schedule/os'

const photoSync = defineSchedule({
  cron: '0 * * * *',
  timeZone: 'Europe/Madrid',
  async handler({ scheduledAt }) {
    console.log(`Syncing photos for ${scheduledAt.toISOString()}`)
  },
})

if (process.argv[2] === 'sync') {
  await executeStaticSchedule({ name: 'photo-sync', definition: photoSync, cron: photoSync.cron, scheduledAt: new Date() })
}

if (process.argv[2] === 'install') {
  const [error, unit] = await installOsSchedule('photo-sync', photoSync, {
    command: [process.execPath, process.argv[1], 'sync'],
    env: { PHOTO_DIR: join(homedir(), 'Pictures') },
    logDir: join(homedir(), '.photo-sync', 'logs'),
  })
  if (error) {
    console.error(`${error.code}: ${error.why}\n${error.fix}`)
    process.exit(1)
  }
  console.log(unit.changed ? `Installed ${unit.files.join(', ')}` : 'The timer is up to date.')
}
```

- `command` is the program and its arguments. The first item must be an absolute path. The program gets the arguments as they are: no shell reads them.
- `env` sets the environment of each run. Nothing comes from the shell that installs the timer.
- `logDir` gets `photo-sync.log` with the output of each run.
- Run `install` again after each change. When nothing changed, it changes no file and returns `changed: false`.
- The install replaces only a timer that it installed itself, in the same scope. When the OS already has a timer, unit, plist, or task with that name, it returns `SCHEDULE_OS_NAME_TAKEN` and changes nothing.

The function returns `[error, unit]`. It does not throw when the OS cannot run the Schedule exactly. See [Rejections](#rejections).

## What each OS gets

| OS | User scope (default) | System scope |
| --- | --- | --- |
| Linux | systemd user timer and service in the folder that your systemd user manager reads, `~/.config/systemd/user/` by default | systemd timer and service in `/etc/systemd/system/` |
| macOS | LaunchAgent in `~/Library/LaunchAgents/<name>.plist` | LaunchDaemon in `/Library/LaunchDaemons/<name>.plist` |
| Windows | Task Scheduler task `\<name>` that runs as you while you are signed in | Task Scheduler task `\<name>` that runs as SYSTEM |

Set `scope: 'system'` to run the command when nobody is signed in. System scope needs root or an Administrator.

`catchUp` is `true` by default. When the computer is off or asleep at a time, the OS runs the command once after it starts or wakes. launchd runs a missed time only after sleep, not after the Mac was off, and you cannot turn it off: `catchUp: false` is rejected on macOS. `randomDelaySeconds` starts each run up to that many seconds late on Linux and Windows.

### Keep a Linux timer running after you sign out

systemd stops your user timers when your last session ends, unless lingering is on. `unit.linger` and `status.linger` tell you. Turn it on once:

```bash
loginctl enable-linger "$USER"
```

## Logs

| OS | Without `logDir` | With `logDir` |
| --- | --- | --- |
| Linux | The journal: `journalctl --user -u photo-sync` | `<logDir>/<name>.log` |
| macOS | `~/Library/Logs/<name>/<name>.log` (system: `/Library/Logs/<name>/`) | `<logDir>/<name>.log` |
| Windows | `%LOCALAPPDATA%\<name>\Logs\<name>.log` (system: `%ProgramData%\<name>\Logs\`) | `<logDir>\<name>.log` |

## Read the status

```ts [src/status.ts]
import { osScheduleStatus } from '@vite-hub/schedule/os'

const [error, status] = await osScheduleStatus('photo-sync')
if (error) throw error
console.log(status.installed, status.lastExitCode, status.nextRunAt)
```

| Field | Linux | macOS | Windows |
| --- | --- | --- | --- |
| `installed`, `running` | Yes | Yes | Yes |
| `lastRunAt` | Yes | No: launchd does not keep it | Yes |
| `lastExitCode` | Yes | Yes | Yes |
| `nextRunAt` | Yes | Calculated from the cron | Yes |
| `linger` | User scope | No | No |
| `logFile` | With `logDir` | Yes | Yes |

Pass `{ scope: 'system' }` for a system timer. `installed` is `false` for a timer of that name that ViteHub did not install in that scope.

## Remove the timer

Call `unit.uninstall()`, or `uninstallOsSchedule('photo-sync')` from another process. It stops the timer, removes the files that the install wrote and the log file, and returns `existed: false` when there was nothing to remove. A timer of the same name that ViteHub did not install in that scope stays as it is, and the result is `existed: false`.

## Time zones

The cron of a Schedule uses UTC unless it sets `timeZone`.

- systemd accepts any time zone, so Linux runs every cron in its zone.
- launchd and Task Scheduler use the time zone of the computer. `installOsSchedule()` accepts the Schedule only when the computer runs it at the same times:
  - the zone is the computer's zone,
  - or the two zones always differ by the same amount, and the install moves the times,
  - or the cron gives the same runs in both zones. The hourly cron in the example works on a computer in any zone with a whole-hour offset.

Other cases return `SCHEDULE_OS_TIME_ZONE_UNSUPPORTED`, with the computer's zone in `error.data.machineTimeZone`. Set `timeZone` to that zone, or pick a cron that gives the same runs in both zones.

On the nights the clocks change, the OS decides, not ViteHub:

- Linux: a time in the hour that the clocks skip, such as `30 2 * * *` in Madrid on the last Sunday of March, does not run that night. A time in the hour that repeats runs once.
- macOS: a time in the hour that repeats runs once. launchd does not document what it does with a skipped time.
- Windows: fixed times run as on Linux. A cron that repeats all day at equal gaps, such as `*/15 * * * *`, runs in the repeated hour twice.

The Process Runtime and the host crons run a skipped time once, at the next valid minute.

## Rejections

| Code | When |
| --- | --- |
| `SCHEDULE_OS_INVALID_OPTIONS` | The name, cron, time zone, or an option is not valid, or `command[0]` is not an absolute path. |
| `SCHEDULE_OS_CRON_UNSUPPORTED` | The OS cannot run the cron exactly. Windows rejects a cron that limits both the weekday and the month, and a cron that needs more than 48 triggers. Task Scheduler repeats a trigger in elapsed time, so a repetition that a clock change of the computer's zone would move becomes one trigger per time. macOS rejects a cron that needs more than 1000 calendar entries. |
| `SCHEDULE_OS_NAME_TAKEN` | The OS has a timer, unit, plist, or task with that name that ViteHub did not install in that scope. `error.data.resource` names it. |
| `SCHEDULE_OS_OPTION_UNSUPPORTED` | macOS gets `catchUp: false` or `randomDelaySeconds`. |
| `SCHEDULE_OS_TIME_ZONE_UNSUPPORTED` | macOS or Windows cannot run the cron in `timeZone`. |
| `SCHEDULE_OS_PERMISSION_REQUIRED` | System scope without root or an Administrator. |
| `SCHEDULE_OS_PLATFORM_UNSUPPORTED` | The OS is not Linux, macOS, or Windows. |
| `SCHEDULE_OS_COMMAND_FAILED` | `systemctl`, `launchctl`, or PowerShell failed. `error.data.output` has its output. |

Each code has a page in [Schedule diagnostics](/docs/schedule/diagnostics).

::warning
An OS timer is not the [Process Runtime](/docs/schedule/configure). It runs your command, not a server, and it records no Schedule Runs in KV. Use it for a CLI or a desktop tool. Use host cron or the Process Runtime for an app.
::

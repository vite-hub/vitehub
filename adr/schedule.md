# @vite-hub/schedule decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Generated code imports Schedule runtime modules by absolute path, not by package export

`startedTickSource`, `scheduleConsoleDefinition (inspect runtime.module)`, `scheduleRuntimeEntry`, `scheduleStaticRuntimeImport`, `scheduleRuntimeModule/scheduleProcessRuntimeModule/scheduleStaticRuntimeModule`, `privateEntries` in `packages/schedule/src/discovery.ts`, `packages/schedule/src/inspect.ts`, `packages/schedule/src/internal/provider-output.ts`, `packages/schedule/src/vite.ts`, `packages/schedule/vite.config.ts`.

**Context:** Generated Nitro plugins, provider functions, the started-Schedule tick and Console readers import Schedule runtime modules through ownModule() absolute paths. Apps may only install `vite-hub`, not `@vite-hub/schedule` by name, and these modules are not package exports (vite.config privateEntries). Deno cron output is the exception: it keeps npm packages external and imports `@vite-hub/schedule/runtime/static` from the deployed package.

**Decision:** Keep generated imports as resolved file paths (ownModule/import.meta.resolve). Only Deno output uses the package specifier.

**Consequences:** Switching to bare specifiers breaks apps that do not list @vite-hub/schedule; removing the path import from Deno output breaks Deno cron. Making these entries public exports would widen the API.

## Published diagnostic codes stay stable; retired Schedule codes are never reused

`scheduleErrorDiagnostics`, `osScheduleErrors`, `startedScheduleErrors` in `packages/schedule/src/error-diagnostics.ts`, `packages/schedule/src/os/errors.ts`, `packages/schedule/src/started-errors.ts`.

**Context:** Codes link to vitehub.dev/docs/schedule/diagnostics and each started-Schedule code has a heading on that docs page. The retired list exists only in this comment: SCHEDULE_R0001, SCHEDULE_R0002, SCHEDULE_R0036, SCHEDULE_R0037, SCHEDULE_R0038.

**Decision:** Never rename or reuse a published code. Retired codes: SCHEDULE_R0001, SCHEDULE_R0002, SCHEDULE_R0036, SCHEDULE_R0037, SCHEDULE_R0038. Keep a docs heading per started-Schedule code.

**Consequences:** Reusing a retired code makes old docs links and user catches match a different failure. Move the retired list into data (catalog or docs) before the comment is deleted.

## Done-marker TTL must outlast catch-up window plus lease wait

`createProcessWakeDriver.nextQueued`, `createOccurrenceClaims`, `installProcessScheduleRuntime (doneTtlMs)` in `packages/schedule/src/internal/process-wake-runtime.ts`, `packages/schedule/src/runtime/claims.ts`, `packages/schedule/src/runtime/process.ts`.

**Context:** The done marker stops a second run of an occurrence. Its TTL is catchUpMs + leaseTtlMs + 2 minutes. Queued work older than catchUpMs is dropped because its marker may have expired. When the done-marker write fails, the claim is renewed for the done TTL instead of released. A failed release is acceptable because the marker already blocks a rerun.

**Decision:** doneTtlMs >= catchUpMs + leaseTtlMs + slack; drop queued occurrences older than catchUpMs; on marker failure keep the claim for doneTtl.

**Consequences:** Shortening doneTtl or lengthening catch-up without the other lets an occurrence run twice across processes.

## A backwards wall-clock correction must not reset per-minute dedupe

`createProcessWakeDriver.enqueue` in `packages/schedule/src/internal/process-wake-runtime.ts`.

**Context:** enqueue returns early when currentMinute < occurrenceMinute instead of resetting `dispatched`.

**Decision:** Ignore scans in a minute earlier than the last dispatched minute.

**Consequences:** Resetting the dedupe set on a clock step back runs that minute twice when the clock moves forward again.

## Deterministic run ids dedupe deliveries; a claimed unfinished run is retried

`createProcessWakeDriver.catchUp`, `executeSchedule`, `ExecuteScheduleOptions.claimed`, `installProcessScheduleRuntime (recovery of unfinished runs)` in `packages/schedule/src/internal/process-wake-runtime.ts`, `packages/schedule/src/runtime/execute.ts`, `packages/schedule/src/runtime/process.ts`.

**Context:** Run ids derive from schedule + scheduled minute. Catch-up after restart re-dispatches minutes after each Schedule's latest cron run within catchUpMs; minutes that already ran are deduped by id. A finished run never runs again. When the caller holds the claim, a pending/running run belongs to a dead process and gets a new attempt (old attempts marked failed). Catch-up starts after the newest cron run even if unfinished, and such occurrences retry through the claim at each scan.

**Decision:** Keep run ids deterministic; treat existing pending/running runs as lost only when `claimed` is true.

**Consequences:** Random run ids or rerunning without the claim would duplicate runs on repeated delivery or across servers.

## Deno cron numbers weekdays 1-7 from Sunday

`renderDenoCron (weekday names)` in `packages/schedule/src/internal/provider-output.ts`.

**Context:** Deno.cron does not use standard 0-6 weekday numbers, so the generator rewrites the weekday field to SUN..SAT names.

**Decision:** Emit weekday names, not numbers, in Deno cron output.

**Consequences:** Passing numeric weekdays through shifts every weekday Schedule by one day on Deno.

## Netlify publication is atomic: functions and retained sources move as one pair

`publishNetlifyOutput (backup/restore)`, `generateProviderOutputsWithinLock` in `packages/schedule/src/internal/provider-output.ts`.

**Context:** Output root and retained sources are swapped with a backup; a failed restore is retried without deleting either complete pair; after commit, cleanup errors are ignored so a successful publish is not reported failed. Recovery of an interrupted Netlify publication runs before any generation work can fail or abort.

**Decision:** Recover first, swap as a pair, preserve backups on failed restore, ignore post-commit cleanup errors.

**Consequences:** Reordering recovery after generation or moving functions without sources can leave Netlify functions pointing at missing sources.

## Time zone offsets are sampled over two years, assuming at most one offset change per day

`sampledDays (time-zone-cron.ts, os/time-zone.ts)`, `offsetChanges` in `packages/schedule/src/internal/time-zone-cron.ts`, `packages/schedule/src/os/time-zone.ts`.

**Context:** Two years cover every offset of a zone's current rules; each DST period is longer than a day, so offsetChanges finds at most one change per day.

**Decision:** Keep the 2 * 366 day window and the one-change-per-day assumption together.

**Consequences:** A shorter window misses offsets; a zone with two changes in a day would be mis-sampled.

## UTC host crons over-wake and the runtime checks the local date

`utcCronForTimeZone` in `packages/schedule/src/internal/time-zone-cron.ts`.

**Context:** When local times do not all shift to the same UTC day (or day/month fields are set), the UTC cron wakes every day and the Schedule runtime filters by local due time.

**Decision:** Only shift weekday lists when every time moves to the same UTC day; else wake daily.

**Consequences:** Removing the runtime local-date check or the daily fallback skips or duplicates runs on UTC-only hosts.

## Schedule operations load the runtime module lazily

`runtime (operations.ts)` in `packages/schedule/src/operations.ts`.

**Context:** The runtime module needs the run store and the Nitro registry. Operations import it on call so the CLI and `vitehub inspect` can list operations without it.

**Decision:** Keep `import("./runtime/operations.ts")` dynamic.

**Consequences:** A static import makes `vitehub inspect`/CLI listing load the Nitro runtime and fail outside the app.

## launchd user scope falls back from gui/<uid> to user/<uid>

`createLaunchdDriver (domains, bootstrap)` in `packages/schedule/src/os/launchd.ts`.

**Context:** Over SSH a user has no gui domain; bootstrap there fails with code 125 "Domain does not support specified action", so the driver tries the user domain next.

**Decision:** Try gui/<uid> then user/<uid>; treat 125 or that message as no login session.

**Consequences:** Dropping the fallback breaks user-scope install over SSH.

## Unit and plist ownership compares real paths

`createLaunchdDriver.owner`, `foreignResource` in `packages/schedule/src/os/launchd.ts`, `packages/schedule/src/os/systemd.ts`.

**Context:** launchd prints the real plist path (/private/var for /var homes) and systemd may print FragmentPath with symlinks resolved (dotfiles-linked ~/.config). Paths are compared after realpath.

**Decision:** Compare paths with realpath before calling a resource foreign.

**Consequences:** Plain string comparison reports ViteHub's own unit as foreign on macOS /var homes and dotfile setups.

## launchctl bootstrap retries error 5 after bootout

`bootstrapIn` in `packages/schedule/src/os/launchd.ts`.

**Context:** launchd finishes bootout in the background, so an immediate bootstrap can fail with "5: Input/output error"; the driver retries up to 10 times, 200 ms apart.

**Decision:** Retry bootstrap on error 5.

**Consequences:** Removing the retry makes reinstall flaky on macOS.

## systemd values reject line breaks (setting injection)

`validateOsScheduleSpec (linux branch)` in `packages/schedule/src/os/schedules.ts`.

**Context:** A newline ends a systemd setting, so a value with a line break could add settings of its own. installOsSchedule rejects them before render.

**Decision:** Reject CR/LF in command, env, cwd, logDir, description on Linux.

**Consequences:** Removing the check allows unit-file injection from user-provided values.

## systemd weekday ranges start Monday and cannot wrap

`systemdCalendars` in `packages/schedule/src/os/systemd.ts`.

**Context:** Sunday is mapped to 7 and the list sorted, because systemd weeks start on Monday and ranges like Sat..Mon are invalid.

**Decision:** Map weekday 0 to 7 and sort before building ranges.

**Consequences:** Using cron 0-6 order produces invalid or wrong OnCalendar= ranges.

## systemctl --user needs XDG_RUNTIME_DIR

`createSystemdDriver (execEnv)` in `packages/schedule/src/os/systemd.ts`.

**Context:** `sudo -u` and cron jobs do not set XDG_RUNTIME_DIR, so the driver sets /run/user/<uid>.

**Decision:** Set XDG_RUNTIME_DIR when missing for user scope.

**Consequences:** Without it, systemctl --user cannot reach the user manager from sudo/cron.

## systemd install restarts the timer

`createSystemdDriver.install` in `packages/schedule/src/os/systemd.ts`.

**Context:** restart (not start) re-reads new OnCalendar= lines and also starts a stopped timer.

**Decision:** Use `systemctl restart` after enable.

**Consequences:** `start` leaves a running timer on the old calendar.

## systemd uninstall cleans the Persistent= stamp

`createSystemdDriver.uninstall` in `packages/schedule/src/os/systemd.ts`.

**Context:** Persistent=true stores the last run time; a later install with the same name would read it and start a catch-up run at once. `systemctl clean --what=state` removes it; systemd < 243 has no `clean`, so its result is ignored.

**Decision:** Run `clean --what=state` on uninstall and ignore failure.

**Consequences:** Removing it causes surprise immediate runs after reinstall.

## Keep per-time triggers across DST, TimeTrigger + endless repetition for 'always', fixed local StartBoundary, year>=2000 filter, XML via file

`crossesChange`, `machineTriggers`, `renderTaskXml`, `statusScript`, `createTaskSchedulerDriver.install` in `packages/schedule/src/os/task-scheduler.ts`.

**Context:** Task Scheduler repeats triggers in elapsed time, so runs across a clock change shift; such runs need one trigger per time, except an all-day equal-gap cron whose gap divides the change. A TimeTrigger starts once and a repetition without duration never ends. StartBoundary is a fixed past date read in machine local time with DST. Task Scheduler reports 30 Nov 1999 for a nonexistent time. The XML can exceed the -EncodedCommand length limit, so it is written to a file.

**Decision:** Keep per-time triggers across DST, TimeTrigger + endless repetition for 'always', fixed local StartBoundary, year>=2000 filter, XML via file.

**Consequences:** Changing any of these makes Windows runs drift across DST, show 1999 dates, or fail to register long tasks.

## PowerShell quoting rules for task arguments

`powerShellString`, `unsafeWindowsArgument` in `packages/schedule/src/os/task-scheduler.ts`.

**Context:** PowerShell treats typographic single quotes (U+2018..U+201B) as quotes, so they are doubled. Windows PowerShell 5.1 joins native arguments without escaping, so quotes, empty arguments, or trailing backslashes in spaced arguments are rejected.

**Decision:** Double all single-quote variants; reject arguments 5.1 would mangle.

**Consequences:** Dropping either allows command injection or silently changed arguments on Windows.

## Task ownership marker names the scope

`renderTaskXml (managed description)` in `packages/schedule/src/os/task-scheduler.ts`.

**Context:** User and system tasks share the root folder; each scope owns only tasks whose description marker names it.

**Decision:** Keep `(user|system scope)` in the managed description.

**Consequences:** Without it a scope could remove or overwrite the other scope's task.

## runSchedule registry import marker

`loadRegistry`, `registryModule` in `packages/schedule/src/run.ts`.

**Context:** The Vite plugin transform matches `/* @vite-ignore */ /* @vitehub-schedule-registry */ <ident>` and replaces it with the `#vitehub/schedule/registry` id. The import uses a variable so a build without the plugin still succeeds.

**Decision:** Keep the marker comment and the variable import.

**Consequences:** Deleting the marker stops the transform; runSchedule then throws SCHEDULE_DEFINITION_NOT_FOUND in every plugin build.

## Cross-realm Date check uses Date.prototype.getTime

`isScheduleDate` in `packages/schedule/src/runtime/date.ts`.

**Context:** getTime checks the internal Date slot in every realm; Symbol.toStringTag can be defined or throw.

**Decision:** Use Date.prototype.getTime.call, never toStringTag or instanceof.

**Consequences:** instanceof/toStringTag would reject cross-realm dates or run user getters.

## scheduledAt text needs a zone and explicit range checks

`scheduledAtText`, `parseScheduledAt` in `packages/schedule/src/runtime/date.ts`.

**Context:** A date-time must carry Z or an offset so it does not depend on the server zone. JavaScript accepts T24:00 and rolls 02-30 into March, so the parser checks hour and day-of-month itself.

**Decision:** Require a zone; validate hour and day after Date parsing.

**Consequences:** Relying on Date parsing accepts invalid dates silently.

## DST semantics: skipped times shift forward, repeated times run once

`isRepeatedFixedLocalTime`, `matchesSkippedLocalTime` in `packages/schedule/src/runtime/due.ts`.

**Context:** A local time skipped on spring-forward is read with the pre-gap offset (RFC 5545, Temporal): 02:30 in a 02:00-03:00 gap runs at 03:30. A repeated local minute is detected with the real pre-transition offset, including historical 23-hour rollbacks.

**Decision:** Follow RFC 5545/Temporal disambiguation.

**Consequences:** Other choices skip or double-run fixed-time Schedules on DST days.

## Manual runs do not move the cron catch-up cursor

`installProcessScheduleRuntime.latestScheduledAt` in `packages/schedule/src/runtime/process.ts`.

**Context:** Manual runs can use simulated times, so only `srun_static_` ids count as the latest cron run.

**Decision:** Filter by idPrefix srun_static_.

**Consequences:** Counting manual runs could skip real missed cron minutes.

## The started-Schedules tick records no run

`installProcessScheduleRuntime (wake of runStartedSchedules)` in `packages/schedule/src/runtime/process.ts`.

**Context:** The tick calls runStartedSchedules directly; recording it would add a run every minute. Each started Schedule records its own run.

**Decision:** Do not route the tick through executeSchedule.

**Consequences:** Run history would fill with one tick run per minute.

## Started Schedule lifecycle when the Definition is gone or fails

`runOccurrence` in `packages/schedule/src/runtime/started.ts`.

**Context:** If a deploy removed the Definition or gave it a cron, a one-time Schedule is deleted but a cron Schedule stays and resumes if the Definition returns. A one-time Schedule runs once even when the handler fails; the failed run stays in history.

**Decision:** Delete one-time Schedules after their final attempt or missing Definition; keep recurring ones.

**Consequences:** Changing this either loses recurring Schedules on a bad deploy or retries one-time ones forever.

## Static dispatch settles every Schedule and rethrows with cause

`runStaticSchedules` in `packages/schedule/src/runtime/static.ts`.

**Context:** Hosts log only the rejection, without its cause, and one failure must not hide the others.

**Decision:** Use Promise.allSettled and aggregate failures into the rejection message.

**Consequences:** Promise.all hides other Schedules' results; relying on cause loses detail in host logs.

## isCallable accepts HTMLDDA values

`isCallable` in `packages/schedule/src/runtime/static.ts`.

**Context:** document.all-like values are callable but report typeof undefined, hence `typeof value === "undefined" && value !== undefined`.

**Decision:** Keep the HTMLDDA branch.

**Consequences:** The branch looks like dead code; removing it misclassifies callable HTMLDDA values.

## Static provider entry stays free of the Node-backed Cloudflare runtime module

`readCloudflareWaitUntil` in `packages/schedule/src/runtime/static.ts`.

**Context:** The Cloudflare waitUntil reader is inlined so the provider entry does not import the shared Node-backed module.

**Decision:** Do not replace with the shared helper import.

**Consequences:** Importing it pulls Node built-ins into Worker bundles.

## KV key order is not a contract: over-cap unindexed history fails explicitly

`createKVScheduleRunStore.readSnapshot`, `createKVScheduleRunStore.listRuns` in `packages/schedule/src/runtime/store.ts`.

**Context:** When more than maxLegacyHistoryRecords records lack a metadata index, the store does not read a provider-ordered subset; listRuns throws SCHEDULE_HISTORY_INCOMPLETE instead of returning partial data.

**Decision:** Never return a partial or provider-ordered subset as history.

**Consequences:** Returning a prefix could present an incomplete set as the newest or full history.

## Registry invalidation covers Nitro's environment graph

`invalidateScheduleRegistry` in `packages/schedule/src/vite.ts`.

**Context:** The Nitro dev handler imports the registry in its own environment module graph, so each environment graph is invalidated too.

**Decision:** Invalidate the registry in server.moduleGraph and every environment graph.

**Consequences:** Nitro dev keeps a stale Schedule registry after edits.

## Netlify scheduled functions run inside Nitro's server bundle

`renderNitroScheduleModule` in `packages/schedule/src/vite.ts`.

**Context:** Nitro has no cron on Netlify, so each Schedule gets a scheduled function that runs in Nitro's server bundle with the same plugins, aliases, and bindings as requests.

**Decision:** Reuse the Nitro server bundle for Netlify scheduled functions.

**Consequences:** A separate bundle would skip app Nitro plugins (e.g. Database config).

## Generated Nitro files are written only when bytes change

`writeNitroScheduleFiles (writeFileIfChanged)` in `packages/schedule/src/vite.ts`.

**Context:** A CLI command that loads the project renders the same files while the dev server watches; rewriting identical bytes reloads the Nitro worker, which can read the file while empty.

**Decision:** Keep writeFileIfChanged for generated files.

**Consequences:** Unconditional writes crash or reload the running dev server.

## Build reads static crons from source; dev loads Schedule modules

`resolveScheduleNitroConfig (processTimings)` in `packages/schedule/src/vite.ts`.

**Context:** In build, processTimings come from source so the server starts without importing Schedule modules. In `vite dev`, modules load at startup so an edited cron applies without a new plugin file.

**Decision:** Emit processTimings only for build.

**Consequences:** Emitting timings in dev ignores edited crons; omitting them in build imports every Schedule at startup.

## Contributions are collected again from the resolved plugin list

`configResolved hook` in `packages/schedule/src/vite.ts`.

**Context:** Plugins can be added after the `config` hook; only the resolved list has them all.

**Decision:** Collect plugin Schedule contributions in configResolved.

**Consequences:** Collecting only in config misses contributed Schedules.

## Ignore Nitro's nitro-prerender preset

`inspectable.nitro.setup` in `packages/schedule/src/vite.ts`.

**Context:** Nitro's prerenderer installs modules again with preset nitro-prerender before the server build.

**Decision:** Do not overwrite nitroPreset with nitro-prerender.

**Consequences:** The host would resolve to the prerender preset and skip provider output.

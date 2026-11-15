import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const scheduleErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/schedule/diagnostics",
  codes: {
    SCHEDULE_C0001: {
      ...dynamicError,
      fix: "Pass `cron` to `defineSchedule()` as a non-empty string without spaces around it, such as `defineSchedule({ cron: \"0 9 * * *\", handler })`. Remove `cron` for a Schedule that only `startSchedule()` starts.",
    },
    SCHEDULE_C0002: {
      ...dynamicError,
      fix: "Write `cron` as five fields with one space between them (minute, hour, day of month, month, day of week), such as `\"0 9 * * 1-5\"`.",
    },
    SCHEDULE_C0003: {
      ...dynamicError,
      fix: "Pass one object with a `handler` to `defineSchedule()`, such as `defineSchedule({ cron: \"0 9 * * *\", handler })`.",
    },
    SCHEDULE_C0004: {
      ...dynamicError,
      fix: "Use only the `cron`, `handler`, `manual`, and `timeZone` options in `defineSchedule()`, written in the object itself. Remove the other options.",
    },
    SCHEDULE_C0005: {
      ...dynamicError,
      fix: "Set `handler` in `defineSchedule()` to a function, such as `handler: async () => { ... }`.",
    },
    SCHEDULE_C0006: {
      ...dynamicError,
      fix: "Set `manual` in `defineSchedule()` to `true` or `false`. Set `timeZone` only together with `cron`, and use an IANA time zone, such as `\"Europe/Madrid\"`.",
    },
    SCHEDULE_C0007: {
      ...dynamicError,
      fix: "Write `defineSchedule({ cron, handler })`. Run `npx @vite-hub/codemods define-forms` to rewrite every Schedule.",
    },
    SCHEDULE_R0001: dynamicError,
    SCHEDULE_R0002: dynamicError,
    SCHEDULE_R0003: dynamicError,
    SCHEDULE_R0004: dynamicError,
    SCHEDULE_R0005: dynamicError,
    SCHEDULE_R0006: dynamicError,
    SCHEDULE_R0022: dynamicError,
    SCHEDULE_R0023: dynamicError,
    SCHEDULE_R0024: dynamicError,
    SCHEDULE_R0025: dynamicError,
    SCHEDULE_R0026: dynamicError,
    SCHEDULE_R0027: dynamicError,
    SCHEDULE_R0028: dynamicError,
    SCHEDULE_R0030: dynamicError,
    SCHEDULE_R0031: dynamicError,
    SCHEDULE_R0032: dynamicError,
    SCHEDULE_R0033: dynamicError,
    SCHEDULE_R0034: dynamicError,
    SCHEDULE_R0035: dynamicError,
    SCHEDULE_R0036: dynamicError,
    SCHEDULE_R0037: dynamicError,
    SCHEDULE_R0038: dynamicError,
    SCHEDULE_B0001: {
      ...dynamicError,
      fix: "Set `runtime: { driver: \"process\" }` in `hubSchedule()` or in `vitehub({ schedule })`, or remove `runtime` to let the host wake Schedules.",
    },
    SCHEDULE_B0002: {
      ...dynamicError,
      fix: "Set `runtime.prefix` in `hubSchedule()` or in `vitehub({ schedule })` to a string, such as `\"my-app:schedule\"`, or remove it to use `vitehub:schedule`.",
    },
    SCHEDULE_B0003: {
      ...dynamicError,
      fix: "Set `runtime.intervalMs` in `hubSchedule()` or in `vitehub({ schedule })` to a number greater than 0 and not more than `60000`, or remove it to use `60000`.",
    },
    SCHEDULE_B0004: {
      ...dynamicError,
      fix: "Set `runtime.concurrency` in `hubSchedule()` or in `vitehub({ schedule })` to an integer of 1 or more, or remove it to use 1.",
    },
    SCHEDULE_B0005: {
      ...dynamicError,
      fix: "Write the Schedule file that the message names as `export default defineSchedule({ cron: \"...\", handler })`, with literal option values and no spread or computed keys. If the file has a syntax error, correct it first.",
    },
    SCHEDULE_B0006: {
      ...dynamicError,
      fix: "Rename or remove one of the two Schedule definitions that the message lists. Each Schedule name must have one file in `server/schedules/` or one plugin contribution.",
    },
    SCHEDULE_B0007: {
      ...dynamicError,
      fix: "Correct the `vitehub.schedules` entry of the plugin that the message names. Give it a `name` and `definition: { module, export: \"default\" }`, where `module` is the absolute path or `file:` URL of a file that exists.",
    },
    SCHEDULE_B0008: {
      ...dynamicError,
      fix: "Set `cron` in `hubSchedule()` or in `vitehub({ schedule })` to a map of Schedule names to cron strings, such as `{ cleanup: \"0 0 * * *\" }`, and use only the names of existing Schedules. With the Process Runtime, remove `cron`, or set `providerOutput` to `\"nitro\"` or `\"standalone\"`.",
    },
    SCHEDULE_B0009: {
      ...dynamicError,
      fix: "Set Schedule `runtime.leaseTtlMs` to a finite number greater than zero, or omit it to use the 60000 ms default.",
    },
    SCHEDULE_RUNTIME_CATCH_UP_INVALID: {
      why: "Schedule Process Runtime catchUpMs must be a non-negative number.",
      fix: "Set `runtime.catchUpMs` in `hubSchedule()` or in `vitehub({ schedule })` to a number of 0 or more, or remove it to use one hour (`3600000`).",
    },
  },
})

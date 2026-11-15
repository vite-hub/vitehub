import { defineDiagnostics } from "nostics"

import type { Diagnostics } from "nostics"

const dynamicError: { why: (params: { message?: unknown }) => string } = {
  why: ({ message }) => message === undefined ? "" : String(message),
}

type RuntimeErrorCode =
  | "RUNTIME_R0001"
  | "RUNTIME_R0002"
  | "RUNTIME_R0003"
  | "RUNTIME_R0004"
  | "RUNTIME_R0005"
  | "RUNTIME_R0006"
  | "RUNTIME_R0007"
  | "RUNTIME_R0009"
  | "RUNTIME_R0010"
  | "RUNTIME_R0011"
  | "RUNTIME_R0015"
  | "RUNTIME_R0016"
  | "RUNTIME_R0017"
  | "RUNTIME_R0018"

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: RUNTIME_R0008.
// The closed record also supports isolated declaration output.
const codes: Record<RuntimeErrorCode, typeof dynamicError & { fix?: string }> = {
  RUNTIME_R0001: { ...dynamicError, fix: "Pass `maxDepth` to `normalizeRuntimeDiagnosticError()` as an integer of 0 or more, or remove it to use the default." },
  RUNTIME_R0002: { ...dynamicError, fix: "Pass `maxErrors` to `normalizeRuntimeDiagnosticError()` as an integer of 1 or more, or remove it to use the default." },
  RUNTIME_R0003: { ...dynamicError, fix: "Pass `maxStringLength` to `normalizeRuntimeDiagnosticError()` as an integer of 64 or more, or remove it to use the default." },
  RUNTIME_R0004: { ...dynamicError, fix: "Read the logs of the process that `vitehub drain` waited for to find why its drain failed, then fix that failure and run `vitehub drain` again." },
  RUNTIME_R0005: { ...dynamicError, fix: "Read the logs of the process that the message names to find why it stopped, then start it again before you run `vitehub drain`." },
  RUNTIME_R0006: { ...dynamicError, fix: "Pass `new ViteHubError()` a nonempty `code` and `message` string within the length limits, and plain JSON `details`." },
  RUNTIME_R0007: { ...dynamicError, fix: "Give the execution authority a valid value for each of `credentials`, `environment`, `filesystem.access`, `filesystem.scope`, `isolation`, `network`, and `processes`." },
  RUNTIME_R0009: { ...dynamicError, fix: "Set `intervalMs` of the process reconciler to a number of milliseconds from 1 to 2147483647." },
  RUNTIME_R0010: { ...dynamicError, fix: "Give the process reconciler a `signal` other than `SIGKILL` or `SIGSTOP`, or set `signal: false`." },
  RUNTIME_R0011: { ...dynamicError, fix: "Call `drain()` of the process reconciler after its callback returns, not from inside the callback." },
  RUNTIME_R0015: { ...dynamicError, fix: "Pass the `Request` of a Fetchable handler, or the event of an H3 or Nitro route, to `getStandardContext()`." },
  RUNTIME_R0016: { ...dynamicError, fix: "Return the body or a `Response` from the handler, in place of setting `~standard.res.body`." },
  RUNTIME_R0017: dynamicError,
  RUNTIME_R0018: dynamicError,
}

export const runtimeErrorDiagnostics: Diagnostics<typeof codes, []> = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes,
})

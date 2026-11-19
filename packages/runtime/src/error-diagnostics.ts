import { defineDiagnostics } from "nostics"

import type { Diagnostics } from "nostics"

interface RuntimeCodeParams {
  counter?: string
  message?: unknown
  option?: string
  suggestion?: string
  unit?: string
  value?: string
}

interface RuntimeCodeDefinition {
  why: (params: RuntimeCodeParams) => string
  fix?: string | ((params: RuntimeCodeParams) => string)
}

const dynamicError: RuntimeCodeDefinition = {
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
  | "RUNTIME_CONSOLE_PATH_INVALID"
  | "RUNTIME_CONSOLE_PROJECT_URL_INVALID"
  | "RUNTIME_DURATION_INVALID"
  | "RUNTIME_EXECUTION_BUDGET_AMOUNT_INVALID"
  | "RUNTIME_EXECUTION_BUDGET_EXCEEDED"
  | "RUNTIME_EXECUTION_BUDGET_LIMIT_INVALID"
  | "RUNTIME_SERIALIZED_RESPONSE_INVALID"

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: RUNTIME_R0008.
// The closed record also supports isolated declaration output.
const codes: Record<RuntimeErrorCode, RuntimeCodeDefinition> = {
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
  // Named errors. Keep these codes in alphabetical order.
  RUNTIME_CONSOLE_PATH_INVALID: {
    why: ({ value }) => `${value} is not a Console path. Use a path that starts with one /, such as /agents/<agent>.`,
    fix: "Pass `hostedConsoleUrl()` a Console path that starts with one `/`, such as `/kv` or `/agents/<agent>/invocations/<id>`.",
  },
  RUNTIME_CONSOLE_PROJECT_URL_INVALID: {
    why: ({ value }) => `${value} is not a project URL. Use the https:// origin of the app, with its base path if it has one.`,
    fix: "Pass `hostedConsoleUrl()` the `https://` origin of the app, or `http://localhost` in development, with its base path and without a user name or password.",
  },
  RUNTIME_DURATION_INVALID: {
    why: ({ option, value }) => `${option ? `\`${option}\`` : "The value"} is ${value}, which is not a duration. A duration is a string with a number of 0 or more and a unit, such as "30s", "5m", or "1 day".`,
    fix: ({ suggestion, unit = "milliseconds", value }) => suggestion
      ? `Write the time as a string with a unit: ${value} ${unit} is ${suggestion}.`
      : "Write a number of 0 or more and one unit: `ms`, `s`, `m`, `h`, `d`, or `w`, or a long name such as `minutes` or `days`. For example `\"30s\"`, `\"5m\"`, or `\"1 day\"`.",
  },
  RUNTIME_EXECUTION_BUDGET_AMOUNT_INVALID: {
    why: ({ counter }) => `[vitehub] Execution budget ${counter} amount must be a finite non-negative number.`,
    fix: "Pass `consume()` and the `record*()` methods of the execution budget a finite number of 0 or more.",
  },
  RUNTIME_EXECUTION_BUDGET_EXCEEDED: {
    why: ({ counter }) => `[vitehub] Execution budget exhausted for ${counter}.`,
    fix: "Raise the `executionBudget` limit that `error.counter` names, such as `maxToolCalls`, `maxRetries`, `maxInputBytes`, or `maxOutputBytes`, or give the run less work.",
  },
  RUNTIME_EXECUTION_BUDGET_LIMIT_INVALID: {
    why: () => "[vitehub] Execution budget limits must be finite non-negative numbers.",
    fix: "Set each limit of `executionBudget`, such as `maxToolCalls` or `maxOutputBytes`, to a finite number of 0 or more, or remove it.",
  },
  RUNTIME_SERIALIZED_RESPONSE_INVALID: {
    why: () => "Invalid serialized Response",
    fix: "Pass `deserializeResponse()` the record that `serializeResponse()` returned, unchanged. Check it first with `isSerializedResponse()`.",
  },
}

export const runtimeErrorDiagnostics: Diagnostics<typeof codes, []> = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/runtime/diagnostics",
  codes,
})

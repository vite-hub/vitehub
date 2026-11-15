import { defineDiagnostics } from "nostics"

import type { Diagnostics } from "nostics"

interface RuntimeCodeDefinition {
  why: (params: { counter?: string, message?: unknown }) => string
  fix?: string
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
  | "RUNTIME_R0008"
  | "RUNTIME_R0009"
  | "RUNTIME_R0010"
  | "RUNTIME_R0011"
  | "RUNTIME_R0015"
  | "RUNTIME_R0016"
  | "RUNTIME_R0017"
  | "RUNTIME_R0018"
  | "RUNTIME_EXECUTION_BUDGET_EXCEEDED"
  | "RUNTIME_EXECUTION_BUDGET_LIMIT_INVALID"

// Each code identifies one ViteHub failure site. Keep published codes stable.
// The closed record also supports isolated declaration output.
const codes: Record<RuntimeErrorCode, RuntimeCodeDefinition> = {
  RUNTIME_R0001: dynamicError,
  RUNTIME_R0002: dynamicError,
  RUNTIME_R0003: dynamicError,
  RUNTIME_R0004: dynamicError,
  RUNTIME_R0005: dynamicError,
  RUNTIME_R0006: dynamicError,
  RUNTIME_R0007: dynamicError,
  RUNTIME_R0008: dynamicError,
  RUNTIME_R0009: dynamicError,
  RUNTIME_R0010: dynamicError,
  RUNTIME_R0011: dynamicError,
  RUNTIME_R0015: dynamicError,
  RUNTIME_R0016: dynamicError,
  RUNTIME_R0017: dynamicError,
  RUNTIME_R0018: dynamicError,
  // Named errors. Keep these codes in alphabetical order.
  RUNTIME_EXECUTION_BUDGET_EXCEEDED: {
    why: ({ counter }) => `[vitehub] Execution budget exhausted for ${counter}.`,
    fix: "Raise the `executionBudget` limit that `error.counter` names, such as `maxToolCalls`, `maxRetries`, `maxInputBytes`, or `maxOutputBytes`, or give the run less work.",
  },
  RUNTIME_EXECUTION_BUDGET_LIMIT_INVALID: {
    why: () => "[vitehub] Execution budget limits must be finite non-negative numbers.",
    fix: "Set each limit of `executionBudget`, such as `maxToolCalls` or `maxOutputBytes`, to a finite number of 0 or more, or remove it.",
  },
}

export const runtimeErrorDiagnostics: Diagnostics<typeof codes, []> = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes,
})

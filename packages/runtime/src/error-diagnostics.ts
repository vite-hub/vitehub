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
  | "RUNTIME_R0008"
  | "RUNTIME_R0009"
  | "RUNTIME_R0010"
  | "RUNTIME_R0011"
  | "RUNTIME_R0012"
  | "RUNTIME_R0013"
  | "RUNTIME_R0014"

// Each code identifies one ViteHub failure site. Keep published codes stable.
// The closed record also supports isolated declaration output.
const codes: Record<RuntimeErrorCode, typeof dynamicError> = {
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
  RUNTIME_R0012: dynamicError,
  RUNTIME_R0013: dynamicError,
  RUNTIME_R0014: dynamicError,
}

export const runtimeErrorDiagnostics: Diagnostics<typeof codes, []> = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics",
  codes,
})

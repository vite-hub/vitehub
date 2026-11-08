import type { Diagnostic } from "nostics"

// These diagnostics use gateway-owned text, without provider bodies or credential values.
const publicCodes = new Set(["GATEWAYS_R0002", "GATEWAYS_R0006", "GATEWAYS_R0008", "GATEWAYS_R0009", "GATEWAYS_R0011"])
const publicDiagnostics = new WeakMap<Error, { message: string, fix?: string }>()

export function recordPublicAiGatewayDiagnostic(diagnostic: Diagnostic<unknown>): void {
  if (publicCodes.has(diagnostic.code)) publicDiagnostics.set(diagnostic, { message: diagnostic.message, fix: diagnostic.fix })
}

/** Client-safe text captured when this package creates a known gateway diagnostic. */
export function getPublicAiGatewayDiagnostic(cause: unknown): { message: string, fix?: string } | undefined {
  return cause instanceof Error ? publicDiagnostics.get(cause) : undefined
}

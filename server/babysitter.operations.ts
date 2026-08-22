import {
  normalizeRuntimeDiagnosticError,
  type RuntimeDiagnosticEvent,
} from 'vite-hub/runtime'

export function operationalEventLine(
  event: string,
  detail: Record<string, unknown> = {},
  timestamp = new Date().toISOString(),
): string {
  return `[babysitter] ${JSON.stringify({ ...detail, event, timestamp })}`
}

export function logOperationalEvent(event: string, detail: Record<string, unknown> = {}): void {
  console.info(operationalEventLine(event, detail))
}

export function logOperationalError(event: string, error: unknown, detail: Record<string, unknown> = {}): void {
  console.error(operationalEventLine(event, {
    ...detail,
    error: normalizeRuntimeDiagnosticError(error, { includeStack: true }),
  }))
}

export function reportOperationalDiagnostic(diagnostic: RuntimeDiagnosticEvent): void {
  const line = operationalEventLine(diagnostic.name, {
    ...diagnostic,
    name: undefined,
    timestamp: undefined,
  }, diagnostic.timestamp)
  if (diagnostic.level === 'error') console.error(line)
  else if (diagnostic.level === 'warn') console.warn(line)
  else console.info(line)
}

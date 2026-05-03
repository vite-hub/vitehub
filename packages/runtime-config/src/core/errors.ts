export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(`[vitehub] ${message}`)
    this.name = "RuntimeConfigError"
  }
}

export function assertNever(value: never): never {
  throw new RuntimeConfigError(`Unexpected runtime config declaration: ${JSON.stringify(value)}`)
}

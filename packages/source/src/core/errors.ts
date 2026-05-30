export class SourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SourceError"
  }
}

export class SourceNotFoundError extends SourceError {
  constructor(name: string) {
    super(`[vitehub] Source "${name}" is not registered.`)
    this.name = "SourceNotFoundError"
  }
}

export class SourcePathError extends SourceError {
  constructor(path: string) {
    super(`[vitehub] Source path escapes the source root: ${JSON.stringify(path)}.`)
    this.name = "SourcePathError"
  }
}

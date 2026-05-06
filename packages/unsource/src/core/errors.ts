export class UnsourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "UnsourceError"
  }
}

export class SourceNotFoundError extends UnsourceError {
  constructor(name: string) {
    super(`[vitehub] Source "${name}" is not registered.`)
    this.name = "SourceNotFoundError"
  }
}

export class SourcePathError extends UnsourceError {
  constructor(path: string) {
    super(`[vitehub] Source path escapes the source root: ${JSON.stringify(path)}.`)
    this.name = "SourcePathError"
  }
}

export class WorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "WorkspaceError"
  }
}

export class WorkspaceNotFoundError extends WorkspaceError {
  constructor(name: string) {
    super(`[vitehub] Workspace "${name}" is not registered.`)
    this.name = "WorkspaceNotFoundError"
  }
}

export class WorkspacePathError extends WorkspaceError {
  constructor(path: string) {
    super(`[vitehub] Workspace path escapes the workspace root: ${JSON.stringify(path)}.`)
    this.name = "WorkspacePathError"
  }
}

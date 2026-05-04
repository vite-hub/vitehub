export class EnvError extends Error {
  constructor(message: string) {
    super(`[vitehub] ${message}`)
    this.name = "EnvError"
  }
}

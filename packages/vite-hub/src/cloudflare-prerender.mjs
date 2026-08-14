export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
  }
}

export class EmailMessage {
  constructor(from, to, raw) {
    this.from = from
    this.to = to
    this.raw = raw
  }
}

export class WorkflowEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
  }
}

export const env = {}
export const waitUntil = () => {}

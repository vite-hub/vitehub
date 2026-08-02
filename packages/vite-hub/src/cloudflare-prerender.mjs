export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
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

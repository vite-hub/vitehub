declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    protected ctx: unknown
    protected env: Env
    constructor(ctx: unknown, env: Env)
  }
}

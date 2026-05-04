declare module "cloudflare:workers" {
  export class DurableObject<TEnv = unknown> {
    constructor(ctx: DurableObjectState, env: TEnv)
  }
}

type DurableObjectLocationHint =
  | "wnam"
  | "enam"
  | "sam"
  | "weur"
  | "eeur"
  | "apac"
  | "oc"
  | "afr"
  | "me"

interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): unknown
  get(id: unknown, options?: { locationHint?: DurableObjectLocationHint }): T
}

interface DurableObjectState {
  storage: unknown
}

type ExportedHandlerFetchHandler<TEnv = unknown> = (
  request: Request,
  env: TEnv,
  ctx: { waitUntil?: (promise: Promise<unknown>) => void },
) => Response | Promise<Response>

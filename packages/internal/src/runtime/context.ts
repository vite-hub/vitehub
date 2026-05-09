export type MaybePromise<T> = T | Promise<T>

export type RuntimeWaitUntil = (task: Promise<unknown>) => void

export interface RuntimeHostContext<TRuntimeConfig = Record<string, unknown>> {
  capabilities?: RuntimeCapabilities
  cloudflare?: {
    context?: unknown
    durableObjectStateName?: string
    env?: Record<string, unknown>
  }
  event?: unknown
  memo<T>(key: string, create: () => T): T
  platform?: string
  request?: Request
  runtime: string
  runtimeConfig?: TRuntimeConfig
  vercel?: {
    waitUntil?: RuntimeWaitUntil
  }
  waitUntil: RuntimeWaitUntil
}

export type ResolvedRuntimeHostContext<
  TRuntimeConfig = Record<string, unknown>,
> = RuntimeHostContext<TRuntimeConfig> & {
  runtimeConfig: TRuntimeConfig
}

export interface RuntimeCapabilityHandle<TKind extends string = string, TValue = unknown> {
  kind: TKind
  value: TValue
}

export type RuntimeCapabilities = Record<string, RuntimeCapabilityHandle | unknown>

export interface Resolvable<T, TContext extends RuntimeHostContext<any> = RuntimeHostContext> {
  resolve(context: TContext): MaybePromise<T>
}

export type MaybeResolvable<T, TContext extends RuntimeHostContext<any> = RuntimeHostContext> =
  | T
  | Resolvable<T, TContext>
  | ((context: TContext) => MaybePromise<T>)

export function isResolvable<T, TContext extends RuntimeHostContext<any>>(
  value: MaybeResolvable<T, TContext>,
): value is Resolvable<T, TContext> {
  return typeof value === "object"
    && value !== null
    && "resolve" in value
    && typeof (value as { resolve?: unknown }).resolve === "function"
}

export async function resolveRuntimeValue<T, TContext extends RuntimeHostContext<any>>(
  value: MaybeResolvable<T, TContext>,
  context: TContext,
): Promise<T> {
  if (isResolvable(value)) {
    return await value.resolve(context)
  }

  if (typeof value === "function") {
    return await (value as (context: TContext) => MaybePromise<T>)(context)
  }

  return value
}

export function resolveRuntimeContext<
  TRuntimeConfig,
  TContext extends RuntimeHostContext<TRuntimeConfig>,
>(
  context: TContext,
): TContext & { runtimeConfig: TRuntimeConfig } {
  return {
    ...context,
    runtimeConfig: (context.runtimeConfig || {}) as TRuntimeConfig,
  }
}

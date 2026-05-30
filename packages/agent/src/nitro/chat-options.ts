import type { AgentRuntimeConfig, AgentRuntimeContext, MaybePromise } from "../types.ts"

export interface NitroChatRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentRuntimeContext<TRuntimeConfig> {
  runtimeConfig: TRuntimeConfig
}

function createCallbackContext<TRuntimeConfig extends AgentRuntimeConfig>(
  context: NitroChatRuntimeContext<TRuntimeConfig>,
) {
  const { runtimeConfig: _runtimeConfig, ...callbackContext } = context
  return callbackContext
}

function isResolvable<T>(value: unknown): value is { resolve: (context: ReturnType<typeof createCallbackContext>) => MaybePromise<T> } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { resolve?: unknown }).resolve === "function"
}

export async function resolveChatRuntimeValue<T>(
  value: unknown,
  context: NitroChatRuntimeContext,
): Promise<T> {
  const callbackContext = createCallbackContext(context)
  if (typeof value === "function") {
    return await (value as (context: typeof callbackContext) => MaybePromise<T>)(callbackContext)
  }
  if (isResolvable<T>(value)) {
    return await value.resolve(callbackContext)
  }
  return value as T
}

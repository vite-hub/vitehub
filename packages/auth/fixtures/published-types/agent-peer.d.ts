declare module "@vite-hub/agent" {
  export interface AgentInvoker {
    id: string
    kind: string
    label?: string
    meta?: Record<string, unknown>
  }

  export interface AgentRuntimeConfig {}

  export interface AgentInvokerResolveContext<
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    CALL_OPTIONS = unknown,
  > {
    callOptions?: CALL_OPTIONS
    request?: Request
    runtimeConfig?: TRuntimeConfig
  }

  export interface AgentInvokerOptions<
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    CALL_OPTIONS = unknown,
  > {
    resolve?: (context: AgentInvokerResolveContext<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<AgentInvoker | undefined>
  }

  export type MaybePromise<T> = Promise<T> | T
}

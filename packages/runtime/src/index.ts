export type MaybePromise<T> = T | Promise<T>

export type RuntimeWaitUntil = (task: Promise<unknown>) => void

export interface TraceContext {
  id: string
  parentId?: string
  sampled?: boolean
}

export interface TraceEvent {
  attributes?: Record<string, unknown>
  name: string
  timestamp?: Date | string
  trace?: TraceContext
  type: "approval" | "capability" | "error" | "lifecycle" | "policy" | "run"
}

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
  trace?: TraceContext
  vercel?: {
    waitUntil?: RuntimeWaitUntil
  }
  waitUntil: RuntimeWaitUntil
}

export type ExecutionContext<TRuntimeConfig = Record<string, unknown>> =
  RuntimeHostContext<TRuntimeConfig> & {
    runtimeConfig: TRuntimeConfig
  }

export type ResolvedRuntimeHostContext<TRuntimeConfig = Record<string, unknown>> =
  ExecutionContext<TRuntimeConfig>

export interface CapabilityHandle<TKind extends string = string, TValue = unknown> {
  kind: TKind
  name?: string
  value: TValue
}

export type RuntimeCapabilityHandle<TKind extends string = string, TValue = unknown> =
  CapabilityHandle<TKind, TValue>

export type RuntimeCapabilities = Record<string, CapabilityHandle | unknown>

export interface CapabilityDefinition<TKind extends string = string, TValue = unknown> {
  handle: CapabilityHandle<TKind, TValue>
  resolve(context: ExecutionContext): MaybePromise<CapabilityHandle<TKind, TValue>>
}

export interface Resolvable<T, TContext extends RuntimeHostContext<any> = RuntimeHostContext> {
  resolve(context: TContext): MaybePromise<T>
}

export type MaybeResolvable<T, TContext extends RuntimeHostContext<any> = RuntimeHostContext> =
  | T
  | Resolvable<T, TContext>
  | ((context: TContext) => MaybePromise<T>)

export interface PolicyContext {
  capability?: string
  input?: unknown
  operation?: string
  runtime?: string
  subject?: unknown
  trace?: TraceContext
}

export type PolicyDecision = "allow" | "deny" | "require-approval" | "retryable-failure"

export type CapabilityPolicy = PolicyDecision | ((context: PolicyContext) => MaybePromise<PolicyDecision>)

export type ApprovalState = "proposed" | "awaiting-approval" | "approved" | "denied" | "executing" | "completed" | "failed"

export interface ApprovalRequest<TInput = unknown> {
  id: string
  capability?: string
  input?: TInput
  reason?: string
  state: Extract<ApprovalState, "awaiting-approval" | "proposed">
  trace?: TraceContext
}

export interface ApprovalDecision {
  approved: boolean
  decidedAt?: Date | string
  reason?: string
  requestId: string
  state: Extract<ApprovalState, "approved" | "denied">
}

export interface RunLifecycleHooks<TContext extends RuntimeHostContext<any> = RuntimeHostContext> {
  approval?: (request: ApprovalRequest, context: TContext) => MaybePromise<void>
  error?: (error: unknown, context: TContext) => MaybePromise<void>
  finish?: (context: TContext) => MaybePromise<void>
  request?: (context: TContext) => MaybePromise<void>
  trace?: (event: TraceEvent, context: TContext) => MaybePromise<void>
}

export interface Lease {
  expiresAt?: Date | string
  id: string
  key: string
  release(): MaybePromise<void>
}

export interface LeaseStore {
  acquire(key: string, options?: { owner?: string, ttl?: number }): MaybePromise<Lease>
}

export class CapabilityNotFoundError extends Error {
  constructor(name: string) {
    super(`[vitehub:runtime] Capability "${name}" was not found.`)
    this.name = "CapabilityNotFoundError"
  }
}

export class CapabilityDeniedError extends Error {
  constructor(name: string, reason?: string) {
    super(`[vitehub:runtime] Capability "${name}" was denied${reason ? `: ${reason}` : "."}`)
    this.name = "CapabilityDeniedError"
  }
}

export class ApprovalRequiredError<TInput = unknown> extends Error {
  request: ApprovalRequest<TInput>

  constructor(request: ApprovalRequest<TInput>) {
    super(`[vitehub:runtime] Approval is required for "${request.capability || request.id}".`)
    this.name = "ApprovalRequiredError"
    this.request = request
  }
}

export function createExecutionContext<
  TRuntimeConfig,
  TContext extends RuntimeHostContext<TRuntimeConfig>,
>(
  context: TContext,
): TContext & ExecutionContext<TRuntimeConfig> {
  return resolveExecutionContext(context)
}

export function resolveExecutionContext<
  TRuntimeConfig,
  TContext extends RuntimeHostContext<TRuntimeConfig>,
>(
  context: TContext,
): TContext & ExecutionContext<TRuntimeConfig> {
  return {
    ...context,
    capabilities: context.capabilities || {},
    runtimeConfig: (context.runtimeConfig || {}) as TRuntimeConfig,
  }
}

export function resolveRuntimeContext<
  TRuntimeConfig,
  TContext extends RuntimeHostContext<TRuntimeConfig>,
>(
  context: TContext,
): TContext & ExecutionContext<TRuntimeConfig> {
  return {
    ...context,
    runtimeConfig: (context.runtimeConfig || {}) as TRuntimeConfig,
  }
}

export function defineCapability<TKind extends string, TValue>(
  kind: TKind,
  value: TValue,
  options: { name?: string } = {},
): CapabilityHandle<TKind, TValue> {
  return {
    kind,
    name: options.name,
    value,
  }
}

function isCapabilityHandle(value: unknown): value is CapabilityHandle {
  return typeof value === "object"
    && value !== null
    && "kind" in value
    && typeof (value as { kind?: unknown }).kind === "string"
    && "value" in value
}

export function hasCapability(context: RuntimeHostContext, name: string): boolean {
  return !!context.capabilities && name in context.capabilities
}

export function getCapability<TKind extends string = string, TValue = unknown>(
  context: RuntimeHostContext,
  name: string,
): CapabilityHandle<TKind, TValue> {
  const value = context.capabilities?.[name]
  if (value === undefined) {
    throw new CapabilityNotFoundError(name)
  }
  if (isCapabilityHandle(value)) {
    return value as CapabilityHandle<TKind, TValue>
  }
  return defineCapability(name as TKind, value as TValue, { name })
}

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

export async function resolveCapabilityPolicy(
  policy: CapabilityPolicy | undefined,
  context: PolicyContext,
): Promise<PolicyDecision> {
  if (!policy) return "allow"
  return typeof policy === "function" ? await policy(context) : policy
}

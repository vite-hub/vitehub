import type {
  LeaseStore,
  MaybePromise,
  TraceEvent,
} from "@vite-hub/runtime"
import type {
  Browser as PlaywrightBrowser,
  BrowserContext,
  Page,
} from "playwright-core"

export interface BrowserFeatures {
  liveHandoff: boolean
}

export type BrowserIsolation = "process" | "provider" | "trusted-host"

export interface BrowserProviderInfo {
  features: BrowserFeatures
  isolation: BrowserIsolation
  name: string
}

export interface BrowserProviderOpenOptions {
  idleTimeoutMs?: number
}

export interface BrowserProviderSession<TConnection = unknown> {
  close(): MaybePromise<void>
  connection: TConnection
  expiresAt?: Date | string
  features?: Partial<BrowserFeatures>
  id: string
}

export interface BrowserProvider<TConnection = unknown> extends BrowserProviderInfo {
  open(options?: BrowserProviderOpenOptions): MaybePromise<BrowserProviderSession<TConnection>>
}

export interface BrowserControllerLease<TClient> {
  client: TClient
  preservesSessionOnRelease?: boolean
  release(): MaybePromise<void>
}

export interface BrowserControl<TClient> {
  readonly client: TClient
  release(): Promise<void>
}

export interface BrowserControllerContext {
  provider: BrowserProviderInfo
  sessionId: string
}

export interface BrowserController<TClient, TConnection = unknown> {
  attach(
    connection: TConnection,
    context: BrowserControllerContext,
  ): MaybePromise<BrowserControllerLease<TClient>>
  features: {
    attachExistingSession: boolean
  }
  name: string
}

export type BrowserSessionState = "closed" | "controlled" | "handed-off" | "released"

export interface BrowserSessionInfo {
  expiresAt?: string
  features: BrowserFeatures
  id: string
  provider: string
  state: BrowserSessionState
}

export interface BrowserSessionRef {
  readonly audience: string
  readonly expiresAt: string
  readonly id: string
}

export interface BrowserHandoffOptions {
  audience: string
  mode: "live"
  ttl?: number
}

export interface BrowserClaimOptions {
  audience: string
}

export interface BrowserSession<TConnection = unknown> {
  readonly id: string
  attach<TClient>(controller: BrowserController<TClient, TConnection>): Promise<BrowserControl<TClient>>
  close(): Promise<void>
  handoff(options: BrowserHandoffOptions): Promise<BrowserSessionRef>
  inspect(): BrowserSessionInfo
}

export interface BrowserClient<TConnection = unknown> {
  claim(ref: BrowserSessionRef, options: BrowserClaimOptions): Promise<BrowserSession<TConnection>>
  open(options?: BrowserProviderOpenOptions): Promise<BrowserSession<TConnection>>
}

export interface BrowserPolicy {
  handoffTtl?: number
  idleTimeoutMs?: number
}

export interface CreateBrowserOptions<TConnection> {
  leaseStore?: LeaseStore
  policy?: BrowserPolicy
  provider: BrowserProvider<TConnection>
  trace?: (event: TraceEvent) => MaybePromise<void>
}

export interface BrowserPageSession {
  readonly browser: PlaywrightBrowser
  readonly context: BrowserContext
  readonly id: string
  readonly page: Page
  close(): Promise<void>
  inspect(): BrowserSessionInfo
}

export interface BrowserDefinitionBrowser {
  open(options?: BrowserProviderOpenOptions): Promise<BrowserPageSession>
}

export interface BrowserDefinitionContext {
  browser: BrowserDefinitionBrowser
}

export type BrowserDefinitionHandler<TInput = unknown, TResult = unknown> = (
  input: TInput,
  context: BrowserDefinitionContext,
) => MaybePromise<TResult>

export interface BrowserDefinition<TInput = unknown, TResult = unknown> {
  run: BrowserDefinitionHandler<TInput, TResult>
}

export type BrowserDefinitionRegistry = Record<
  string,
  BrowserDefinition | (() => Promise<BrowserDefinition | { default?: BrowserDefinition }>)
>

export interface BrowserRuntimeConfig {
  binding: string
  provider?: "cloudflare"
}

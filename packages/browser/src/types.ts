import type {
  LeaseStore,
  MaybePromise,
  TraceEvent,
} from "@vite-hub/runtime"

export interface BrowserFeatures {
  artifacts: boolean
  liveHandoff: boolean
  stateExport: boolean
  stateImport: boolean
}

export type BrowserIsolation = "process" | "provider" | "trusted-host"

export interface BrowserProviderInfo {
  features: BrowserFeatures
  isolation: BrowserIsolation
  name: string
}

export interface BrowserProviderOpenOptions {
  idleTimeoutMs?: number
  state?: BrowserState
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

export interface BrowserState<T = unknown> {
  data: T
  mediaType: string
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
  readonly audience?: string
  readonly expiresAt: string
  readonly id: string
}

export interface BrowserHandoffOptions {
  audience?: string
  mode: "live"
  ttl?: number
}

export interface BrowserClaimOptions {
  audience?: string
}

export interface BrowserSession<TConnection = unknown> {
  readonly id: string
  close(): Promise<void>
  handoff(options: BrowserHandoffOptions): Promise<BrowserSessionRef>
  inspect(): BrowserSessionInfo
  use<TClient, TResult>(
    controller: BrowserController<TClient, TConnection>,
    run: (client: TClient) => MaybePromise<TResult>,
  ): Promise<TResult>
}

export interface BrowserClient<TConnection = unknown> {
  claim(ref: BrowserSessionRef, options?: BrowserClaimOptions): Promise<BrowserSession<TConnection>>
  open(options?: BrowserProviderOpenOptions): Promise<BrowserSession<TConnection>>
  withSession<TResult>(
    run: (session: BrowserSession<TConnection>) => MaybePromise<TResult>,
    options?: BrowserProviderOpenOptions,
  ): Promise<TResult>
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

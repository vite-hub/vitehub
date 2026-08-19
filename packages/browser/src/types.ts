import type {
  LeaseStore,
  MaybePromise,
  TraceEvent,
  ViteHubError,
} from "@vite-hub/runtime"

export interface BrowserDownload {
  url(): string
}

export interface BrowserPageLocator {
  screenshot(options?: Record<string, unknown>): Promise<Uint8Array>
}

export interface BrowserPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>
  locator(selector: string): BrowserPageLocator
  title(): Promise<string>
}

export type BrowserEngine = "chromium" | "kitesurf"

export type BrowserRunAction =
  | "accessibilityTree"
  | "content"
  | "json"
  | "links"
  | "markdown"
  | "pdf"
  | "scrape"
  | "screenshot"
  | "snapshot"

export type BrowserRunActionInput = string | ({ url?: string } & Record<string, unknown>)

export interface BrowserRunActionOptions {
  binding?: string | unknown
  resolveBinding?: (name: string) => MaybePromise<unknown>
}

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
  readonly browser: unknown
  readonly context: unknown
  readonly id: string
  readonly page: BrowserPage
  close(): Promise<void>
  inspect(): BrowserSessionInfo
}

export interface BrowserDefinitionBrowser {
  content(input: BrowserRunActionInput): Promise<string>
  open(options?: BrowserProviderOpenOptions): Promise<BrowserPageSession>
  quickAction(action: BrowserRunAction, input: BrowserRunActionInput): Promise<Response>
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

export type BrowserRunResult<TResult = unknown> =
  | [error: null, value: TResult]
  | [error: ViteHubError<`BROWSER_${string}`>, value: undefined]

export type BrowserDefinitionRegistry = Record<
  string,
  BrowserDefinition | (() => Promise<BrowserDefinition | { default?: BrowserDefinition }>)
>

export interface BrowserRuntimeConfig {
  binding: string
  engine?: BrowserEngine
  provider?: "cloudflare"
}

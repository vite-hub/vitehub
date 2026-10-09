import type { EnvAccessContext } from "@vite-hub/env/bridge"
import type { EnvDatabase } from "@vite-hub/env/database"

/** Maximum name length that fits the Env Bridge `connection/<name>` key. */
export const CONNECTION_NAME_MAX_LENGTH = 501

/** Type shape of one provider API method. Generated catalogs describe each method with it. */
export interface ConnectionMethodSignature {
  /** Catalog HTTP method. Only GET reads execute during dry run. */
  method: string
  body: unknown
  params: object
  response: unknown
}

export type ConnectionReadMethod = "GET" | "HEAD" | "OPTIONS"

export function isConnectionReadMethod(method: string): method is ConnectionReadMethod {
  return method === "GET" || method === "HEAD" || method === "OPTIONS"
}

/** Runtime description of one provider API. */
export interface ConnectionApiCatalog {
  /** Base URL that method paths are relative to. */
  readonly rootUrl: string
  /** Method id to `[HTTP method, path template, accepts a JSON body]`. */
  readonly methods: Readonly<Record<string, readonly [string, string, boolean]>>
  /** Write methods that an access rule must name exactly. A trailing `.*` matches a subtree. */
  readonly highRisk?: readonly string[]
}

/** A value, or a function that reads it when the provider needs it, for example from Server Env. */
export type ConnectionValue = string | (() => string | undefined | Promise<string | undefined>)

/** OAuth token endpoint response. */
export interface ConnectionTokenResponse {
  access_token: string
  expires_in?: number
  id_token?: string
  refresh_token?: string
  scope?: string
  token_type?: string
}

export interface ConnectionAccount {
  email?: string
  id: string
}

/** An OAuth 2.0 provider with authorization code, PKCE, and refresh token support. */
export interface ConnectionProvider<TApis extends object = object> {
  readonly id: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly revocationEndpoint?: string
  readonly clientId: ConnectionValue
  readonly clientSecret?: ConnectionValue
  /** Scopes added to each authorization request so the provider identifies the account. */
  readonly identityScopes?: readonly string[]
  readonly authorizationParams?: Readonly<Record<string, string>>
  readonly apis: { readonly [TApi in keyof TApis]: ConnectionApiCatalog }
  /** Read the account identity from the token response of an authorization code exchange. */
  account: (token: ConnectionTokenResponse) => ConnectionAccount | undefined
  /** Type-only method map. It has no runtime value. */
  readonly "~apis"?: TApis
}

type MethodId<TMethods> = keyof TMethods & string
type Prefixes<TId extends string> = TId extends `${infer THead}.${infer TRest}`
  ? `${THead}.*` | `${THead}.${Prefixes<TRest>}`
  : never

/** A method id, a subtree such as `users.messages.*`, or `*`. */
export type ConnectionMethodPattern<TMethods> = "*" | MethodId<TMethods> | Prefixes<MethodId<TMethods>>

/** Methods to expose for each provider API. */
export type ConnectionApiSelection<TApis> = {
  readonly [TApi in keyof TApis]?: readonly ConnectionMethodPattern<TApis[TApi]>[]
}

/** An action id such as `gmail.users.messages.modify`, a subtree such as `gmail.users.labels.*`, or `fetch`. */
export type ConnectionActionPattern<TApis> =
  | { [TApi in keyof TApis & string]: `${TApi}.${ConnectionMethodPattern<TApis[TApi]>}` }[keyof TApis & string]
  | "fetch"

/**
 * What one actor may do with a Connection.
 *
 * GET methods are reads. Other methods are writes.
 */
export interface ConnectionAccessRule<TPattern extends string = string> {
  read?: boolean
  /** Allowed writes. `true` allows every write that is not high risk. `"approve"` allows the same writes after approval. */
  write?: readonly TPattern[] | true | "approve"
  /** Require approval for each allowed write. Defaults to `true` for `agent:` actors. */
  approve?: boolean
}

/** Result of an API key `verify` check. `false` rejects the key. `account` labels the Connection in inspection. */
export type ConnectionApiKeyVerification = boolean | { account?: ConnectionAccount }

export interface ConnectionApiKeyVerifyContext {
  /** The runtime fetch. Send the key only to the provider. */
  fetch: typeof fetch
  /** Aborts the check after 30 seconds. */
  signal: AbortSignal
}

/** A provider whose credential is a static API key. An admin sets the key at runtime. */
export interface ConnectionApiKeyProvider<TApis extends object = object> {
  readonly kind: "api-key"
  readonly id: string
  /** Lowercase request header that carries the key. */
  readonly header: string
  /** Text before the key in the header value, for example `Bearer`. Omit to send the bare key. */
  readonly scheme?: string
  /** Origins that `fetch` may send the key to. API catalog root URLs are also allowed. */
  readonly origins: readonly string[]
  readonly apis: { readonly [TApi in keyof TApis]: ConnectionApiCatalog }
  /** Check a new key before ViteHub stores it. */
  verify?: (key: string, context: ConnectionApiKeyVerifyContext) => Promise<ConnectionApiKeyVerification>
  /** Type-only method map. It has no runtime value. */
  readonly "~apis"?: TApis
}

interface ConnectionDefinitionRules<TApis extends object, TSelection extends ConnectionApiSelection<TApis>> {
  /** API methods to expose. Omit to expose every method of every provider API. */
  api?: TSelection
  /**
   * Access rules by actor, for example `schedule:gmail` or `agent:labeller`.
   * When set, actors not listed are denied. When omitted, server actors may read and
   * call non-high-risk writes, and Agent writes require approval.
   */
  access?: Readonly<Record<string, ConnectionAccessRule<ConnectionActionPattern<TApis>>>>
}

/** A Connection that an account owner grants through OAuth 2.0. */
export interface ConnectionOAuthDefinition<
  TApis extends object = object,
  TSelection extends ConnectionApiSelection<TApis> = ConnectionApiSelection<TApis>,
> extends ConnectionDefinitionRules<TApis, TSelection> {
  provider: ConnectionProvider<TApis>
  /** Provider scopes to request. Inspection reports declared scopes that the grant lacks. */
  scopes: readonly string[]
}

/** A Connection whose credential is a static API key. API keys have no scopes. */
export interface ConnectionApiKeyDefinition<
  TApis extends object = object,
  TSelection extends ConnectionApiSelection<TApis> = ConnectionApiSelection<TApis>,
> extends ConnectionDefinitionRules<TApis, TSelection> {
  provider: ConnectionApiKeyProvider<TApis>
  scopes?: undefined
}

export type ConnectionDefinition<
  TApis extends object = object,
  TSelection extends ConnectionApiSelection<TApis> = ConnectionApiSelection<TApis>,
> = ConnectionOAuthDefinition<TApis, TSelection> | ConnectionApiKeyDefinition<TApis, TSelection>

/** Fetch options supported by Connections. Bodies are persisted for approval replay. */
export type ConnectionFetchInit = Pick<RequestInit, "headers" | "method" | "redirect" | "signal"> & { body?: string }

export type ConnectionDefinitionRegistry = Record<string, () => Promise<unknown>>

/** Loads the ViteHub Database that the default store uses. */
export type ConnectionsDatabaseLoader = () => Promise<EnvDatabase>

export interface DiscoveredConnectionDefinition {
  handler: string
  name: string
  source: "server-connections" | "vite-suffix"
}

export interface ConnectionCallOptions {
  signal?: AbortSignal
}

type Match<TId extends string, TPattern> = TPattern extends "*"
  ? true
  : TPattern extends `${infer TPrefix}.*`
    ? TId extends `${TPrefix}.${string}` ? true : false
    : TId extends TPattern ? true : false

type SelectedMethods<TMethods, TPatterns> = {
  [TId in MethodId<TMethods> as true extends Match<TId, TPatterns> ? TId : never]: TMethods[TId]
}

type MethodInput<TSignature> = TSignature extends { body: infer TBody, params: infer TParams }
  ? TParams & ([TBody] extends [never] ? unknown : { requestBody?: TBody })
  : never

type MethodResponse<TSignature> = TSignature extends { response: infer TResponse } ? TResponse : never
type MethodDryRunResult<TSignature, TDryRun extends boolean> = TSignature extends { method: infer TMethod }
  ? TMethod extends ConnectionReadMethod ? never : true extends TDryRun ? undefined : never
  : true extends TDryRun ? undefined : never

/** A typed provider method. In dry run, a skipped write resolves to `undefined`. */
export type ConnectionMethod<TSignature, TDryRun extends boolean = false> = object extends MethodInput<TSignature>
  ? (input?: MethodInput<TSignature>, options?: ConnectionCallOptions) => Promise<MethodResponse<TSignature> | MethodDryRunResult<TSignature, TDryRun>>
  : (input: MethodInput<TSignature>, options?: ConnectionCallOptions) => Promise<MethodResponse<TSignature> | MethodDryRunResult<TSignature, TDryRun>>

type Head<TId extends string> = TId extends `${infer THead}.${string}` ? THead : TId

/** Nested client built from dotted method ids, for example `gmail.users.labels.list()`. */
export type ConnectionClientTree<TMethods, TDryRun extends boolean = false> = {
  readonly [THead in Head<MethodId<TMethods>>]: (THead extends keyof TMethods ? ConnectionMethod<TMethods[THead], TDryRun> : unknown)
    & ConnectionClientTree<{ [TId in MethodId<TMethods> as TId extends `${THead}.${infer TRest}` ? TRest : never]: TMethods[TId] }, TDryRun>
}

type SelectionPatterns<TSelection, TApi> = TSelection extends { readonly [TKey in TApi & PropertyKey]?: readonly (infer TPattern)[] } ? TPattern : never

export type ConnectionClient<TApis extends object = object, TSelection = ConnectionApiSelection<TApis>, TDryRun extends boolean = false> = {
  readonly name: string
  /**
   * Call a provider URL with the Connection token. GET is a read. Other methods are
   * writes, and an access rule must name `fetch` to allow them.
   */
  fetch: (input: string | URL, init?: ConnectionFetchInit) => Promise<Response>
} & {
  readonly [TApi in keyof TApis & keyof TSelection]: ConnectionClientTree<SelectedMethods<TApis[TApi], SelectionPatterns<TSelection, TApi>>, TDryRun>
}

/** A write that dry run skipped. The fields match the Channel dry-run record. */
export interface ConnectionEffect {
  kind: string
  payload: {
    connection: string
    input?: unknown
    method: string
    url: string
  }
  read: false
  skipped: "dry-run"
}

export interface UseConnectionOptions {
  /** The Env access context of the calling Agent. The ViteHub Agent runtime creates it. An `agent:` actor comes only from it. */
  access?: EnvAccessContext
  /** Actor for policy and activity, for example `schedule:gmail`. Defaults to `server`. `agent:` actors need `access`. */
  actor?: string
  /** Skip provider calls for writes and report each skipped write to `onEffect`. */
  dryRun?: boolean
  /** Reject approval-gated calls without storing a replay request when the caller needs the response immediately. */
  rejectApprovals?: boolean
  invocationId?: string
  onEffect?: (effect: ConnectionEffect) => void
  traceId?: string
}

export type ConnectionStatus = "connected" | "disconnected" | "reauth_required" | "revoked"

export interface ConnectionActionInfo {
  highRisk: boolean
  id: string
  method: string
  write: boolean
}

export interface ConnectionInspection {
  account?: ConnectionAccount
  actions: ConnectionActionInfo[]
  connectedAt?: string
  /** `oauth2` Connections connect through the provider. `api-key` Connections store a key that an admin sets. */
  credential: "api-key" | "oauth2"
  name: string
  provider: string
  refreshedAt?: string
  scopes: {
    declared: string[]
    granted: string[]
    missing: string[]
  }
  status: ConnectionStatus
}

export type ConnectionApprovalStatus = "approved" | "denied" | "executed" | "failed" | "pending"

export interface ConnectionApproval {
  action: string
  actor: string
  createdAt: string
  decidedAt?: string
  decidedBy?: string
  error?: string
  id: string
  input: unknown
  invocationId?: string
  name: string
  status: ConnectionApprovalStatus
  traceId?: string
}

/** A bounded approval page. Pass `nextCursor` as `before` to read older approvals. */
export interface ConnectionApprovalPage {
  approvals: ConnectionApproval[]
  nextCursor?: string
}

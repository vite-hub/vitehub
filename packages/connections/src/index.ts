export { decideConnectionAccess, matchesConnectionPattern } from "./access.ts"
export { defineConnection } from "./definition.ts"
export { isConnectionError } from "./errors.ts"
export { oauth2 } from "./providers/oauth2.ts"
export { useConnection } from "./runtime/state.ts"

export type { ConnectionErrorCode, ConnectionErrorDetails } from "./errors.ts"
export type { OAuth2ProviderOptions } from "./providers/oauth2.ts"
export type { ConnectionName } from "./registry-types.ts"
export type {
  ConnectionAccess,
  ConnectionAccessDecision,
  ConnectionAccessRule,
  ConnectionActivity,
  ConnectionActivityAction,
  ConnectionActivityOutcome,
  ConnectionActor,
  ConnectionAuthorizationInput,
  ConnectionCallResult,
  ConnectionClient,
  ConnectionDefinition,
  ConnectionEffect,
  ConnectionExchangeInput,
  ConnectionOAuthClient,
  ConnectionOperation,
  ConnectionProvider,
  ConnectionProviderContext,
  ConnectionRequest,
  ConnectionSecret,
  ConnectionSkipped,
  ConnectionStatus,
  ConnectionSummary,
  ConnectionTokenSet,
  ConnectionTrace,
  UseConnectionOptions,
} from "./types.ts"

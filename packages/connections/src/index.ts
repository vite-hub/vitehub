export { apiKey } from "./api-key.ts"
export { defineConnection } from "./definition.ts"
export { ConnectionError, isConnectionError } from "./errors.ts"

export type { ApiKeyProviderOptions } from "./api-key.ts"
export type { ConnectionErrorCode, ConnectionErrorDetails, ConnectionErrorReason } from "./errors.ts"
export type { ConnectionDefinitionName } from "./registry-types.ts"
export type {
  ConnectionAccessRule,
  ConnectionAccount,
  ConnectionActionInfo,
  ConnectionActionPattern,
  ConnectionActivityRetention,
  ConnectionApiCatalog,
  ConnectionApiKeyDefinition,
  ConnectionApiKeyFallback,
  ConnectionApiKeyProvider,
  ConnectionApiKeyVerification,
  ConnectionApiKeyVerifyContext,
  ConnectionApiSelection,
  ConnectionApproval,
  ConnectionApprovalPage,
  ConnectionApprovalStatus,
  ConnectionCallOptions,
  ConnectionClient,
  ConnectionClientTree,
  ConnectionDefinition,
  ConnectionDefinitionRegistry,
  ConnectionEffect,
  ConnectionFetchInit,
  ConnectionInspection,
  ConnectionMethod,
  ConnectionMethodPattern,
  ConnectionMethodSignature,
  ConnectionOAuthDefinition,
  ConnectionProvider,
  ConnectionStatus,
  ConnectionTokenResponse,
  ConnectionValue,
  DiscoveredConnectionDefinition,
  UseConnectionOptions,
} from "./types.ts"

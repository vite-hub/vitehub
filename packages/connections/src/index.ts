export { apiKey } from "./api-key.ts"
export { defineConnection } from "./definition.ts"
export { oauthLogin } from "./oauth-login.ts"
export { ConnectionError, isConnectionError } from "./errors.ts"

export type { ApiKeyProviderOptions } from "./api-key.ts"
export type { OAuthLoginProviderOptions } from "./oauth-login.ts"
export type { ConnectionErrorCode, ConnectionErrorDetails, ConnectionErrorReason } from "./errors.ts"
export type { ConnectionDefinitionName } from "./registry-types.ts"
export type {
  ConnectionAccessPreset,
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
  ConnectionInstancesDefinition,
  ConnectionLoginContext,
  ConnectionLoginDefinition,
  ConnectionLoginProvider,
  ConnectionMethod,
  ConnectionMethodPattern,
  ConnectionMethodSignature,
  ConnectionOAuthDefinition,
  ConnectionProvider,
  ConnectionRequestPolicy,
  ConnectionStatus,
  ConnectionTokenResponse,
  ConnectionValue,
  DiscoveredConnectionDefinition,
  UseConnectionOptions,
} from "./types.ts"

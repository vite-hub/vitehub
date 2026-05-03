import type { ChatModuleOptions, ResolvedChatModuleOptions } from "./types.ts"

export const defaultChatWebhookRoute = "/api/webhooks/[platform]"
export const defaultChatWebhookChatParam = "chat"
export const defaultChatWebhookRouteParam = "platform"
export const defaultChatCloudflareDurableObjectBinding = "CHAT_STATE"
export const defaultChatCloudflareDurableObjectClassName = "ChatStateDO"
export const defaultChatCloudflareDurableObjectMigrationTag = "v1"
export const defaultChatCloudflareDurableObjectName = "default"

function normalizeWebhookOptions(webhook: ChatModuleOptions["webhook"]): ResolvedChatModuleOptions["webhook"] {
  if (webhook === false) {
    return false
  }

  if (typeof webhook === "string") {
    return {
      chatParam: defaultChatWebhookChatParam,
      route: webhook,
      routeParam: defaultChatWebhookRouteParam,
    }
  }

  return {
    chatParam: webhook?.chatParam || defaultChatWebhookChatParam,
    route: webhook?.route || defaultChatWebhookRoute,
    routeParam: webhook?.routeParam || defaultChatWebhookRouteParam,
  }
}

export function normalizeChatOptions(options: ChatModuleOptions | false | undefined): false | ResolvedChatModuleOptions {
  if (options === false) {
    return false
  }

  const durableObjectState = options?.cloudflare?.durableObjectState
  const resolved: ResolvedChatModuleOptions = {
    imports: options?.imports !== false,
    webhook: normalizeWebhookOptions(options?.webhook),
  }

  if (durableObjectState && durableObjectState !== true) {
    resolved.cloudflare = {
      durableObjectState: {
        autoWrangler: durableObjectState.autoWrangler !== false,
        binding: durableObjectState.binding || defaultChatCloudflareDurableObjectBinding,
        className: durableObjectState.className || defaultChatCloudflareDurableObjectClassName,
        migrationTag: durableObjectState.migrationTag || defaultChatCloudflareDurableObjectMigrationTag,
        name: durableObjectState.name || defaultChatCloudflareDurableObjectName,
      },
    }
  }
  else if (durableObjectState === true) {
    resolved.cloudflare = {
      durableObjectState: {
        autoWrangler: true,
        binding: defaultChatCloudflareDurableObjectBinding,
        className: defaultChatCloudflareDurableObjectClassName,
        migrationTag: defaultChatCloudflareDurableObjectMigrationTag,
        name: defaultChatCloudflareDurableObjectName,
      },
    }
  }
  else if (durableObjectState === false) {
    resolved.cloudflare = { durableObjectState: false }
  }

  return resolved
}

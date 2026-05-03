import type { ChatModuleOptions, ResolvedChatModuleOptions } from "./types.ts"

const defaultChatWebhookRoute = "/api/webhooks/[platform]"
const defaultChatWebhookChatParam = "chat"
const defaultChatWebhookRouteParam = "platform"
const defaultChatCloudflareDurableObjectBinding = "CHAT_STATE"
const defaultChatCloudflareDurableObjectClassName = "ChatStateDO"
const defaultChatCloudflareDurableObjectMigrationTag = "v1"
export const defaultChatCloudflareDurableObjectName = "default"

export const defaultChatCloudflareDurableObjectState = {
  binding: defaultChatCloudflareDurableObjectBinding,
  className: defaultChatCloudflareDurableObjectClassName,
  migrationTag: defaultChatCloudflareDurableObjectMigrationTag,
}

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
    provider: options?.provider || "auto",
    webhook: normalizeWebhookOptions(options?.webhook),
  }

  if (durableObjectState && durableObjectState !== true) {
    resolved.cloudflare = {
      durableObjectState: {
        autoWrangler: durableObjectState.autoWrangler !== false,
        binding: durableObjectState.binding || defaultChatCloudflareDurableObjectBinding,
        className: durableObjectState.className || defaultChatCloudflareDurableObjectClassName,
        migrationTag: durableObjectState.migrationTag || defaultChatCloudflareDurableObjectMigrationTag,
        name: durableObjectState.name,
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
      },
    }
  }
  else if (durableObjectState === false) {
    resolved.cloudflare = { durableObjectState: false }
  }

  return resolved
}

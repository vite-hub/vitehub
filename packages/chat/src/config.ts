import type { ChatModuleOptions, ResolvedChatModuleOptions } from "./types.ts"

const defaultChatWebhookRoute = "/api/webhooks/[platform]"
const defaultChatWebhookChatParam = "chat"
const defaultChatWebhookRouteParam = "platform"
const defaultChatWebhookProcessing = "defer"
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
      processing: defaultChatWebhookProcessing,
      route: webhook,
      routeParam: defaultChatWebhookRouteParam,
    }
  }

  return {
    chatParam: webhook?.chatParam || defaultChatWebhookChatParam,
    processing: webhook?.processing || defaultChatWebhookProcessing,
    route: webhook?.route || defaultChatWebhookRoute,
    routeParam: webhook?.routeParam || defaultChatWebhookRouteParam,
  }
}

function normalizeDevOptions(dev: ChatModuleOptions["dev"]): ResolvedChatModuleOptions["dev"] {
  if (dev === false) {
    return false
  }

  return {
    devtools: dev?.devtools === false
      ? false
      : typeof dev?.devtools === "object"
        ? { url: dev.devtools.url }
        : {},
    initialize: dev?.initialize !== false,
    localStateFallback: dev?.localStateFallback !== false,
  }
}

export function normalizeChatOptions(options: ChatModuleOptions | false | undefined): false | ResolvedChatModuleOptions {
  if (options === false) {
    return false
  }

  const durableObjectState = options?.cloudflare?.durableObjectState
  const resolved: ResolvedChatModuleOptions = {
    dev: normalizeDevOptions(options?.dev),
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

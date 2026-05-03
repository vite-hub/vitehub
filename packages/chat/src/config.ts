import type { ChatModuleOptions, ResolvedChatModuleOptions } from "./types.ts"

export const defaultChatEntry = "server/chat.ts"
export const defaultChatRoute = "/api/webhooks/[platform]"
export const defaultChatCloudflareDurableObjectBinding = "CHAT_STATE"
export const defaultChatCloudflareDurableObjectClassName = "ChatStateDO"
export const defaultChatCloudflareDurableObjectMigrationTag = "v1"

export function normalizeChatOptions(options: ChatModuleOptions | false | undefined): false | ResolvedChatModuleOptions {
  if (options === false) {
    return false
  }

  const durableObjectState = options?.cloudflare?.durableObjectState
  const resolved: ResolvedChatModuleOptions = {
    entry: typeof options?.entry === "undefined" ? defaultChatEntry : options.entry,
    imports: options?.imports !== false,
    route: typeof options?.route === "undefined" ? defaultChatRoute : options.route,
  }

  if (durableObjectState) {
    resolved.cloudflare = {
      durableObjectState: {
        autoWrangler: durableObjectState.autoWrangler !== false,
        binding: durableObjectState.binding || defaultChatCloudflareDurableObjectBinding,
        className: durableObjectState.className || defaultChatCloudflareDurableObjectClassName,
        migrationTag: durableObjectState.migrationTag || defaultChatCloudflareDurableObjectMigrationTag,
        ...(durableObjectState.name ? { name: durableObjectState.name } : {}),
      },
    }
  }
  else if (durableObjectState === false) {
    resolved.cloudflare = { durableObjectState: false }
  }

  return resolved
}

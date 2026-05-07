---
title: Chat runtime API
description: Reference for Chat exports, module options, handler helpers, runtime context, and Cloudflare state.
navigation.title: Runtime API
navigation.order: 90
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Use this page when you need exact import names and option fields. For a guided setup, start with [Quickstart](./quickstart).

## Imports

Runtime definitions import from `@vitehub/chat`:

```ts
import { defineChat, resolveChat } from '@vitehub/chat'
```

::fw{id="vite:dev vite:build"}
Vite config imports the full plugin from `@vitehub/chat/vite` and the DevTools-only companion from `@vitehub/chat/devtools`:

```ts
import { chatDevTools } from '@vitehub/chat/devtools'
import { hubChat } from '@vitehub/chat/vite'
```
::

::fw{id="nitro:dev nitro:build"}
Nitro config registers the module by name:

```ts
export default defineNitroConfig({
  modules: ['@vitehub/chat/nitro'],
})
```
::

`hubChat()` is the Vite-first integration and contributes the Chat Nitro module automatically. `chatDevTools()` is only the Vite DevTools dock/RPC companion for apps that register `@vitehub/chat/nitro` themselves.

Cloudflare helpers import from `@vitehub/chat/cloudflare`:

```ts
import { cloudflareDurableObjectState, defineCloudflareChatHandler } from '@vitehub/chat/cloudflare'
```

Vercel helpers import from `@vitehub/chat/vercel`:

```ts
import { defineVercelChatHandler } from '@vitehub/chat/vercel'
```

## `defineChat()`

```ts
function defineChat<TRuntimeConfig extends ChatRuntimeConfig>(
  options: DefineChatOptions<TRuntimeConfig>
): ChatDefinition<TRuntimeConfig>
```

`defineChat()` stores a Chat SDK definition that can be resolved later by the generated runtime handler.

### `DefineChatOptions`

```ts
interface DefineChatOptions<TRuntimeConfig> {
  adapters: AdapterInput<ResolvedChatRuntimeContext<TRuntimeConfig>>
  state: MaybeResolvable<StateAdapter, ChatRuntimeContext<TRuntimeConfig>>
  onDirectMessage?: ChatDirectMessageHook<TRuntimeConfig>
  onNewMention?: ChatMessageHook<TRuntimeConfig>
  onNewMessage?: ChatNewMessageHook<TRuntimeConfig> | ChatNewMessageHook<TRuntimeConfig>[]
  onReaction?: ChatReactionHookInput<TRuntimeConfig>
  onAction?: ChatActionHookInput<TRuntimeConfig>
  onModalSubmit?: ChatModalSubmitHookInput<TRuntimeConfig>
  onSubscribedMessage?: ChatMessageHook<TRuntimeConfig>
  workflow?: ChatWorkflowHandle
  hooks?: ChatEventHooks<TRuntimeConfig>
  lifecycleHooks?: ChatWebhookRuntimeHooks<ChatRuntimeContext<TRuntimeConfig>>
  setup?: (bot: Chat, context: ResolvedChatRuntimeContext<TRuntimeConfig>) => MaybePromise<void>
  userName?: ChatConfig['userName']
}
```

The type also accepts Chat SDK config fields except `adapters`, `state`, and `userName`, which ViteHub wraps so they can use runtime context.

Top-level event handlers are the preferred API. `hooks` remains supported for older definitions, but a handler cannot be defined in both places.

## `resolveChat()`

```ts
function resolveChat(
  chat: ChatInput,
  context: ChatRuntimeContext,
  options?: ResolveChatOptions
): Promise<Chat>
```

`resolveChat()` returns a Chat SDK `Chat` instance. Generated handlers call it for each request and memoize the result through `context.memo()`.

## Runtime context

```ts
interface ChatRuntimeContext<TRuntimeConfig = ChatRuntimeConfig> {
  cloudflare?: {
    context?: unknown
    durableObjectStateName?: string
    env?: Record<string, unknown>
  }
  dev?: boolean
  event?: unknown
  memo<T>(key: string, create: () => T): T
  platform?: string
  request?: Request
  runtime: 'nitro' | 'cloudflare' | 'vercel' | 'unknown'
  runtimeConfig?: TRuntimeConfig
  vercel?: {
    waitUntil?: (task: Promise<unknown>) => void
  }
  waitUntil: (task: Promise<unknown>) => void
}
```

Resolvers should use `runtimeConfig` for secrets and app config, `cloudflare.env` for Worker bindings, and `waitUntil` for background webhook work.

## Module options

```ts
interface ChatModuleOptions {
  cloudflare?: {
    durableObjectState?: boolean | ChatCloudflareDurableObjectModuleOptions
  }
  dev?: false | ChatDevModuleOptions
  imports?: boolean
  provider?: 'auto' | 'cloudflare' | 'nitro' | 'vercel'
  webhook?: string | false | ChatWebhookModuleOptions
}
```

| Option | Default | Description |
| --- | --- | --- |
| `provider` | `auto` | Selects generated runtime behavior. `auto` uses the Nitro preset. |
| `webhook` | generated route | Sets or disables webhook route generation. |
| `imports` | `true` | Adds Nitro auto-imports for `defineChat` and handler helpers. |
| `dev` | enabled | Controls local dev initializer and memory state fallback. |
| `cloudflare.durableObjectState` | auto when used | Configures generated Durable Object bindings and migrations. |

### `ChatWebhookModuleOptions`

```ts
interface ChatWebhookModuleOptions {
  chatParam?: string
  route?: string
  routeParam?: string
}
```

`routeParam` names the route param used for the platform. `chatParam` is used when a registry under `server/chats/**` needs to pick a named chat.

### `ChatDevModuleOptions`

```ts
interface ChatDevModuleOptions {
  initialize?: boolean
  localStateFallback?: boolean
}
```

Set `dev: false` to disable both dev behaviors.

## Cloudflare state

```ts
function cloudflareDurableObjectState(
  options?: CloudflareDurableObjectStateOptions
): ChatDurableObjectStateResolver
```

```ts
interface CloudflareDurableObjectStateOptions {
  binding?: string
  className?: string
  locationHint?: 'wnam' | 'enam' | 'sam' | 'weur' | 'eeur' | 'apac' | 'oc' | 'afr' | 'me'
  migrationTag?: string
  name?: string
  shardKey?: (threadId: string) => string
}
```

The default binding is `CHAT_STATE`. The default class name is `ChatStateDO`.

## Handler helpers

### `defineChatWebhookHandler()`

```ts
import { defineChatWebhookHandler } from '@vitehub/chat/nitro'

export default defineChatWebhookHandler(chat, {
  platform: 'telegram',
})
```

Use this helper when you want to mount a Nitro route manually instead of relying on generated routes.

### `defineCloudflareChatHandler()`

```ts
import { defineCloudflareChatHandler } from '@vitehub/chat/cloudflare'

export default {
  fetch: defineCloudflareChatHandler(chat),
}
```

### `defineVercelChatHandler()`

```ts
import { defineVercelChatHandler } from '@vitehub/chat/vercel'

export const POST = defineVercelChatHandler(chat)
```

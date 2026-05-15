---
title: Chat runtime API
description: Reference for Chat exports, definition options, runtime context, and module options.
navigation.title: Runtime API
navigation.order: 3
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Use this page for exact option names.

## Imports

```ts
import {
  defineChat,
  resolveChat,
} from '@vitehub/chat'
```

::fw{id="vite:dev vite:build"}
```ts
import { hubChat } from '@vitehub/chat/vite'
```
::

::fw{id="nitro:dev nitro:build"}
```ts
export default defineNitroConfig({
  modules: ['@vitehub/chat/nitro'],
})
```
::

## Define a chat

```ts
defineChat({
  adapters,
  state,
  userName,
  agent,
  workflow,
  hooks,
  lifecycleHooks,
  setup,
})
```

`adapters` and `state` can be objects, functions, or resolvable objects that receive runtime context.

## Runtime context

```ts
interface ChatRuntimeContext {
  request?: Request
  runtime: 'nitro' | 'cloudflare' | 'vercel' | 'unknown'
  runtimeConfig?: ChatRuntimeConfig
  waitUntil?: (promise: Promise<unknown>) => void
  capabilities?: ChatCapabilities
  memo: <T>(key: string, factory: () => T | Promise<T>) => T | Promise<T>
  dev?: boolean
}
```

Resolvers receive a context with `runtimeConfig` resolved.

## Event hooks

```ts
interface ChatEventHooks {
  onAction?: ChatActionHookInput
  onDirectMessage?: ChatDirectMessageHook
  onModalSubmit?: ChatModalSubmitHookInput
  onNewMention?: ChatMessageHook
  onNewMessage?: ChatNewMessageHook | ChatNewMessageHook[]
  onReaction?: ChatReactionHookInput
  onSubscribedMessage?: ChatMessageHook
}
```

## Agent binding

```ts
type ChatAgentBinding =
  | string
  | {
      name: string
      event?: 'directMessage'
      execution?: 'inline'
      history?: boolean | 'none' | { source: 'thread'; maxMessages?: number }
      hooks?: ChatAgentHooks
    }
```

## Module options

```ts
interface ChatModuleOptions {
  provider?: 'auto' | 'cloudflare' | 'nitro' | 'vercel'
  imports?: boolean
  webhook?: string | false | {
    route?: string
    routeParam?: string
    chatParam?: string
    processing?: 'defer' | 'inline'
  }
  dev?: false | {
    devtools?: boolean | { url?: string }
    initialize?: boolean
    localStateFallback?: boolean
  }
  cloudflare?: {
    durableObjectState?: boolean | {
      binding?: string
      className?: string
      migrationTag?: string
      name?: string
      autoWrangler?: boolean
    }
  }
}
```

## Cloudflare state

```ts
import { cloudflareDurableObjectState } from '@vitehub/chat/cloudflare'

cloudflareDurableObjectState({
  binding: 'CHAT_STATE',
  className: 'ChatStateDO',
})
```

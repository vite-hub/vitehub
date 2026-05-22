# Agent Callbacks Do Not Expose Runtime Config

Agent and Chat callbacks should not expose raw runtime config as user-facing app configuration. App-owned server values are **Runtime Env** and should be read through **Server Env** with `useServerEnv()`; runtime config remains an integration transport for package-owned settings such as generated registry options, provider wiring, hosting, and framework bridge state.

## Considered Options

- Keep passing `runtimeConfig` through callback context and rely on generated Env type augmentation.
- Let each Agent Definition declare a Runtime Config generic once and infer it through all nested callbacks.
- Remove callback `runtimeConfig` and make app code call `useServerEnv()` where it needs app-owned Runtime Env.

## Decision

Remove `runtimeConfig` from public Agent and Chat callback contexts. Callbacks that need application secrets or server configuration should import `useServerEnv()` from `#vitehub/env/server`.

Runtime config may still exist inside framework integrations and package runtime internals as a transport for resolved integration state. It is not the public API for app-owned Runtime Env.

## Consequences

This is a breaking change. Existing callbacks that destructure `{ runtimeConfig }` must switch to `useServerEnv()`.

Agent and Chat callback types become simpler because users no longer need to thread app-specific Runtime Config generics through model, adapter, capability, chat, hook, and eval/test callback surfaces.

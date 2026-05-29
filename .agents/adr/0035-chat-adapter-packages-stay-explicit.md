# Chat Adapter Packages Stay Explicit

ViteHub should keep concrete Chat Platform Adapter and chat state backend packages as explicit optional integrations by default. Application code may import adapter factories from upstream packages such as `@chat-adapter/teams` and `@chat-adapter/state-pg`; ViteHub should not generate or broad-re-export every `@chat-adapter/*` package from `@vitehub/agent`.

The Agent Package owns the Chat Capability, Chat Webhook Route, Chat Webhook Handler, and adapter contract boundary. It does not automatically own every platform adapter implementation or its transitive platform SDK dependencies.

## Evidence

Research artifacts:

- Brief: `/var/folders/85/68jgd5r148j98t_nq6w1r5mh0000gn/T/evidence-research/vitehub/chat-adapter-dx/brief.md`
- Synthesis: `/var/folders/85/68jgd5r148j98t_nq6w1r5mh0000gn/T/evidence-research/vitehub/chat-adapter-dx/synthesis.md`

Ecosystem findings:

- Auth.js keeps database adapters as explicit packages such as `@auth/prisma-adapter`, while core owns adapter contracts and provider descriptors.
- AI SDK providers, Prisma driver adapters, Vite plugins, and Vitest browser/coverage providers use explicit optional packages and direct imports for concrete integrations.
- Better Auth shows that branded facade subpaths are possible, but its mixed `better-auth/adapters/*` and `@better-auth/*-adapter` documentation is a warning about drift when both import paths are supported without a crisp boundary.
- Drizzle and Kysely show that narrow facade subpaths work well when the core package owns a stable first-party shim, while runtime drivers remain user-installed.

## Considered Options

- Bundling Teams, Telegram, Postgres state, and similar packages into `@vitehub/agent` was rejected because optional platform SDKs would become core install weight and version pressure for users who do not use those platforms.
- Generating ViteHub exports for all upstream `@chat-adapter/*` packages was rejected because it mirrors another ecosystem's package topology as ViteHub public API without ViteHub owning those implementations.
- Root-exporting adapter factories from `@vitehub/agent` was rejected because optional integrations would blur the root Agent Package boundary and conflict with the decision that official Capabilities live under `@vitehub/agent/capabilities`.
- Narrow ViteHub facade subpaths remain allowed for first-party-supported adapters, but only when ViteHub owns a real compatibility shim, stable public import path, and clear missing-package diagnostics.

## Consequences

For now, application chat configuration can stay explicit:

```ts
import { createPostgresState } from '@chat-adapter/state-pg'
import { createTeamsAdapter } from '@chat-adapter/teams'
```

If ViteHub later promotes an adapter to first-party support, prefer a narrow subpath such as `@vitehub/agent/chat/teams` or `@vitehub/agent/chat/state-pg` over a broad adapter barrel. That subpath should still treat the underlying adapter or runtime driver as optional/user-installed unless ViteHub intentionally accepts the dependency as core.

Documentation should make the dependency boundary explicit: the Chat Capability owns how adapters are consumed and wired into Agent Triggers; adapter packages own platform-specific construction, SDK dependencies, and release cadence.

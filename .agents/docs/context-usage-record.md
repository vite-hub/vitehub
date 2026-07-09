# Context Usage Record

This note records the source-backed direction for removing the public `usageTelemetry()` Capability API.

## Finding

Expose Agent usage as structured JSON on lifecycle and delivery context: `event.usage` on `AgentFinishEvent` and `context.usage` on `AgentChannelDeliveryFinishEffectContext`.

Do not make ViteHub own a final message, chat, web, markdown, or review-comment abstraction for usage. Apps can format `context.usage` into whatever surface they own.

## Evidence

- `usageTelemetry()` was introduced as a Capability for model usage and cost, not as core Agent Invocation data. Source: PR #138, <https://github.com/vite-hub/vitehub/pull/138>.
- Finish extensions later exposed the same record through `event.extensions.get("usage-telemetry")`. Source: PR #141, <https://github.com/vite-hub/vitehub/pull/141>.
- Before this cleanup, the public API exported `usageTelemetry()`, `getUsageTelemetry()`, pricing, summary, and formatter types from `@vite-hub/agent/capabilities`. Source: `packages/agent/src/capabilities/index.ts`, `packages/agent/src/capabilities/usage-telemetry.ts`.
- Core output normalization already carries structured usage through `AgentUsageRecord`, result `usageRecord`, and stream `{ type: "usage", usageRecord }` events. Source: `packages/agent/src/types.ts`, `packages/agent/src/agent-output.ts`, `packages/agent/src/messages.ts`.
- The Agent Package owns normalizing Agent Usage Records across model-backed, harness-backed, and custom-run-backed Agent Drivers. Source: `.agents/contexts/packages/agent/CONTEXT.md`, `.agents/adr/0054-harness-usage-uses-agent-usage-records.md`.
- App-facing summaries belong outside the framework usage boundary. Source: `.agents/contexts/agents/CONTEXT.md` says ViteHub owns the normalized Agent Usage Record while Agent Usage Summary is app-facing formatted output.
- Before this cleanup, `observability()` nested `usageTelemetry()` by default, which kept the old Capability API alive. Source: PR #396, <https://github.com/vite-hub/vitehub/pull/396>, `packages/agent/src/capabilities/observability.ts`.
- Finish delivery is already context-first, so adding `context.usage` extends the current direction instead of adding another helper. Source: PR #504, <https://github.com/vite-hub/vitehub/pull/504>.

## ADR Conflict

ADR 0017 rejected `event.usage` because usage was optional Capability-owned data. That reason no longer applies once usage is core Agent Invocation accounting. ADR 0032 listed `usageTelemetry()` as an official Capability entry; this cleanup supersedes that entry by keeping usage as Agent Package output context rather than a Capability.

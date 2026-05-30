# AI SDK-Only Model Execution

ViteHub will remove the public Agent `adapter` selector and make AI SDK the only model execution path for now. The TanStack AI adapter and `@vite-hub/agent/tanstack-ai` surface are removed because maintaining multiple model adapters is forcing ViteHub to invent and preserve adapter-neutral message and stream abstractions before the product has proven that cost is worthwhile.

## Considered Options

- Keeping TanStack AI support was rejected because it currently requires lossy message conversion, competes with AI SDK UIMessage streaming work, and is not needed by the Quiver validation environment.
- Keeping `adapter: "ai-sdk"` as explicit ceremony was rejected because it preserves the old multi-adapter design in the public API after only one model execution path remains.
- Designing a fully AI-package-agnostic message and stream layer now was rejected because the active DevTools and trigger work depends on AI SDK UIMessage contracts, and there are no users requiring another adapter.

## Consequences

`defineAgent({ model })` implies AI SDK execution. Future non-AI-SDK execution can return through a new ADR when there is concrete product pressure and a clear boundary that does not distort Chat, DevTools, Capability Triggers, or Quiver validation. Existing internal ViteHub message helpers may remain where they serve Capability lifecycle behavior, but they are no longer justification for a public multi-adapter selector.

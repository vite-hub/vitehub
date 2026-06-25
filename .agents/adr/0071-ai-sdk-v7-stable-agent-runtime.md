# AI SDK v7 Stable Agent Runtime

ViteHub Agent Package targets AI SDK v7 stable for model-backed and harness-backed Agent Drivers. The package catalog should pin stable AI SDK packages instead of canary builds, and the public peer range should require AI SDK v7.

AI SDK remains an optional peer at the package boundary. Model-backed drivers and AI SDK-powered capabilities load it lazily; custom `run()` agents and host route bundles must not need `ai` installed.

Model-backed execution should use AI SDK v7 names directly: `instructions`, `isStepCount`, `telemetry`, `onStepEnd`, `onToolExecutionStart`, `onToolExecutionEnd`, `runtimeContext`, and `stream`. Deprecated aliases may still be read as compatibility input where it costs almost nothing, but ViteHub-owned code should not emit deprecated AI SDK settings.

The ViteHub-only `onRunStepFinish` and `onRunToolCall*` callback shims are removed from the model-backed runtime. AI SDK v7 `runtimeContext` is the native way to carry Agent Invocation data into steps, tools, telemetry, and `prepareStep`.

`@ai-sdk/tui` and `runAgentTUI` are not part of this adoption slice. They are useful for an app-owned terminal chat around a local AI SDK Agent, but ViteHub's current Agent Dev Loop is a server/Vite endpoint debugger with trigger input, context JSON, delivery previews, and runtime traces. Adding a TUI command now would create a second workflow instead of deleting the existing one.

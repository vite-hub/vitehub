# @vite-hub/agent decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Hosted provider tools are dropped under the AI emulator

`createEmulatorToolFilter`, `withoutToolCallSettings` in `packages/agent/src/ai-sdk.ts`.

**Context:** The AI emulator rejects hosted provider tools, such as a provider web search. Tools reach a call from Capabilities, `runAgent(..., { tools })`, and `prepareCall`.

**Decision:** Under model emulation, the filter removes hosted provider tools from the tools and tool choice of every call and step. A tool choice that only a dropped tool can satisfy becomes `"auto"`. Each drop records a coded `agent.diagnostic.warning` observation on the Invocation. Repair calls send no tools, so they use the settings without the filter.

**Consequences:** A new path that adds tools to a call must go through the filter, or emulated runs fail. The run continues as it does without the tool, so a test must read the warning to see the drop.

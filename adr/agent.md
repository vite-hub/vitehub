# @vite-hub/agent decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Hosted provider tools are dropped under the AI emulator

`createEmulatorToolFilter`, `withoutToolCallSettings` in `packages/agent/src/ai-sdk.ts`.

**Context:** The AI emulator rejects hosted provider tools, such as a provider web search. Tools reach a call from Capabilities, `runAgent(..., { tools })`, and `prepareCall`.

**Decision:** Under model emulation, the filter removes hosted provider tools from the tools and tool choice of every call and step. A tool choice that only a dropped tool can satisfy becomes `"auto"`. Each drop records a coded `agent.diagnostic.warning` observation on the Invocation. Repair calls send no tools, so they use the settings without the filter.

**Consequences:** A new path that adds tools to a call must go through the filter, or emulated runs fail. The run continues as it does without the tool, so a test must read the warning to see the drop.

## Server-started pull request triggers share the webhook queue

`githubPullRequestServerTrigger` in `packages/agent/src/channels.ts`.

**Context:** A server send and a webhook can start runs for the same pull request. A caller can also spell the repository with different casing than GitHub does.

**Decision:** Use GitHub's repository spelling, the webhook thread, and the same queue slot for both paths. Use the server send's admission time when applying later branch events. Reattach finish effects when preparing the admitted input because they are not stored in the queue delivery.

**Consequences:** The two paths serialize, and a queued server send still follows the pull request's close and head-move behavior.

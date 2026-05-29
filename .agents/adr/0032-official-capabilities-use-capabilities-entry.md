# Official Capabilities Use Capabilities Entry

Official Agent Capability factories and Capability-owned helpers are public through `@vitehub/agent/capabilities`, not through the root `@vitehub/agent` entry. The root Agent Package entry stays focused on Agent Definition, invocation, message, and generic composition primitives such as `defineAgent()`, `runAgent()`, `streamAgent()`, message helpers, and `defineCapability()`.

## Considered Options

- Keeping common Capabilities such as `chat()` at the root was rejected because it makes Chat look like a special Agent primitive instead of a Capability.
- Re-exporting all official Capabilities from the root was rejected because it turns the Agent Package entry into an ability catalog and weakens the package boundary.
- Moving only model-facing tool Capabilities to the subpath was rejected because input-phase and output-phase Capabilities such as `transcribe()` and `usageTelemetry()` still belong to the Capability Lifecycle.

## Consequences

Agent files import root primitives and official Capabilities separately:

```ts
import { defineAgent } from '@vitehub/agent'
import { chat, transcribe, workspaceShell } from '@vitehub/agent/capabilities'
```

Capability companion helpers, such as `getTranscriptionResults()` and usage pricing helpers, stay beside their Capability factories on `@vitehub/agent/capabilities`. This is a breaking public API cleanup; the library is still in active development, so no compatibility root re-exports are kept.

# Chat Title and Summary Capabilities

ViteHub will model chat title and chat summary as separate chat-scoped Agent Capabilities. `chatTitle()` produces first-user-message conversation metadata and exposes it through the existing Agent response and Agent Invocation Lifecycle path rather than through a separate endpoint. `chatSummary()` produces explicit summary artifacts and owns its natural Input Command surface by default because summary is the product ability and the command is only one trigger mechanism.

## Considered Options

- A generic `title()` or `summary()` helper was rejected because title and summary are chat-scoped product abilities in this design, not generic Agent utilities.
- A single combined title/summary Capability was rejected because title generation has a stable one-message input contract while summary generation operates over conversation history and explicit user or host intent.
- A separate title endpoint was rejected for V1 because title metadata is produced as part of handling the first chat request and should travel with that interaction for client support.
- Naming the summary feature `compact` was rejected because compaction implies reducing or replacing model-facing Chat History, while this feature produces a summary artifact.
- Requiring users to attach both `chatSummary()` and `inputCommands()` for the default summary command was rejected because official Capabilities should map to product abilities rather than implementation mechanisms.

## Consequences

`chatTitle()` is automatic chat metadata for the first user message only. It does not register an Input Command by default, does not support retitling from later messages in V1, does not mutate Chat History, and does not create a separate endpoint as the primary exposure path. Hosts remain responsible for persisting or rendering the generated title.

`chatSummary()` is explicit summary behavior. It can register a natural Input Command by default, with opt-out or customization, but summary generation remains the Capability's product ability. Summary output is a host-visible artifact or metadata result, not hidden Chat History compaction.

Both Capabilities may share an internal auxiliary model-call implementation, but routing, decision, and labelling behavior remain separate future work.

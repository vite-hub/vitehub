# Chat Sessions in Chat Capability

ViteHub will model Chat Sessions as Chat Capability behavior rather than as a standalone Capability. A Chat Session is a host-visible conversation boundary inside Chat History. The Chat Capability resolves the active Chat Session before it applies the Chat History Window and creates an Agent Invocation.

## Considered Options

- A standalone `chatSessions()` Capability was rejected for V1 because Chat Sessions are Chat History behavior, and Chat History already belongs inside the Chat Capability for this stack.
- Hidden semantic slicing was rejected because it can silently remove relevant context and gives users no repair path when a session boundary is wrong.
- Deleting or truncating stored messages was rejected because session selection should be a model-facing view over preserved history, not destructive history mutation.
- Treating `/new`, `/clear`, `/continue`, or `/switch` as Input Commands was rejected because those commands mutate host chat/session state rather than transforming explicit Agent run input.
- Making session selection only manual was rejected because personal, audio, and long-lived chat workflows need developer-selected automatic boundaries such as idle timeout or semantic session selection.

## Consequences

`chat()` may expose a `sessions` option alongside `history`. Manual, idle-timeout, semantic, and hybrid session strategies can be supported without changing the ownership boundary: Chat Sessions remain part of the Chat Capability.

The host persists messages and their Chat Session assignment. The Chat Capability selects messages from the active Chat Session, then applies the configured Chat History Window such as `history.maxMessages`. Session decisions do not erase previous messages.

Manual session actions such as new, clear, continue, and switch are Host Commands. Hosts may render them with slash-style UI, but they are not Input Commands and do not belong to `inputCommands()`.

Semantic Chat Session selection uses the shared pre-invocation decision primitive from ADR 0030. It produces a structured decision such as continue the current session, create a new session, or switch to an existing session. That decision should be inspectable by hosts and repairable by explicit Host Commands.

Full browsing and switching of older sessions is a host/UI feature. The Chat Capability owns the session semantics and trigger behavior, while DevTools or application UIs decide how much session management to expose.

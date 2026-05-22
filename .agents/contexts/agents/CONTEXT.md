# Agents

Agents names definitions, invocations, and runtime state for model-backed server actors.

## Language

**Agent**:
A named server-side actor that receives inputs, runs model-backed behavior, and may attach Capabilities.
_Avoid_: Bot, chat definition, workflow

**Agent Definition**:
The code declaration that names an Agent and configures its model, model adapter, workspace, instructions, and Capabilities.
_Avoid_: Chat definition, server route

**Agent Model Adapter**:
The selected integration layer that turns an Agent Definition's model configuration into model execution.
_Avoid_: LLM provider, provider

**Agent Adapter Options**:
Adapter-owned model execution settings passed through the selected Agent Model Adapter.
_Avoid_: Top-level Agent Definition fields, passthrough, provider options

**Agent Invocation**:
One runtime request to an Agent.
_Avoid_: Chat message, webhook call

**Agent Run State**:
Runtime state created while an Agent Invocation is being processed.
_Avoid_: Chat state, workflow state

**Chat History**:
Ordered conversational messages for one chat interaction with an Agent.
_Avoid_: Agent Memory, Agent Run State

**Chat History Window**:
The bounded number of prior Chat History messages included in an Agent Invocation.
_Avoid_: memory size, transcript limit, context length

**Agent Memory**:
Durable knowledge or preferences an Agent can carry across Agent Invocations when explicitly configured.
_Avoid_: Chat History, better chat state

**Concurrent Invocation Guard**:
Internal Agent behavior that prevents overlapping invocations from mutating the same Agent Run State.
_Avoid_: Public lock API, Capability

**Development State Provider**:
An in-memory or local provider used only for single-process Agent development.
_Avoid_: Production state provider, durable coordination

## Relationships

- An **Agent Definition** declares one **Agent**.
- An **Agent Definition** selects one **Agent Model Adapter** when it uses a model.
- **Agent Adapter Options** belong to the selected **Agent Model Adapter**.
- An **Agent** receives zero or more **Agent Invocations**.
- An **Agent** can attach zero or more Capabilities.
- Tools are contributed by Capabilities, not by top-level Agent Definition fields.
- Workspace Tools are derived from an Agent's Colocated Workspace Definition.
- An **Agent Invocation** can create or update **Agent Run State**.
- **Chat History** is conversation-scoped and is not **Agent Memory**.
- A **Chat History Window** is configured by the Agent Definition when the application wants bounded Chat History.
- The Chat Capability can require state for **Chat History** through the Agent State Provider.
- Chat History is explicit application behavior and is not enabled by default.
- **Agent Memory** can outlive one conversation.
- A **Concurrent Invocation Guard** protects **Agent Run State**.
- A **Development State Provider** is not acceptable for hosted production runtimes.
- Agent callbacks receive Agent-owned runtime metadata, not app-owned Runtime Env; server code reads app-owned Runtime Env through Server Env.

## Example Dialogue

> **Dev:** "Should users configure `tools` directly on the Agent Definition?"
> **Domain expert:** "No. Tools belong inside Capability definitions so validation, policy, and DevTools metadata stay attached to the Capability."

## Flagged Ambiguities

- Raw tools were considered as top-level Agent Definition fields - resolved: tools are contributed by Capabilities.
- Chat runtime state was considered a public Chat option - resolved: use **Agent Run State** for Agent-owned runtime state.
- Chat History and Agent Memory were considered interchangeable - resolved: Chat History is conversation-scoped message history; Agent Memory is durable knowledge or preferences across invocations.
- Chat state was considered separate from Agent State Provider - resolved: Chat History state is satisfied through the Agent State Provider when available.
- Chat History was considered an implicit Chat Capability default - resolved: keep Chat History opt-in, aligned with Chat SDK-style application control.
- Local and hosted state providers were considered equivalent - resolved: hosted production runtimes require a durable provider and a **Concurrent Invocation Guard**.
- Callback runtime config was considered an Agent app configuration surface - resolved: app-owned Runtime Env belongs to Server Env, not Agent callback context.

# Agents

Agents names definitions, invocations, and runtime state for model-backed server actors.

## Language

**Agent**:
A named server-side actor that receives inputs, runs model-backed behavior, and may attach Capabilities.
_Avoid_: Bot, chat definition, workflow

**Agent Definition**:
The code declaration that names an Agent and configures its model, workspace, instructions, and Capabilities.
_Avoid_: Chat definition, server route

**Agent Invocation**:
One runtime request to an Agent.
_Avoid_: Chat message, webhook call

**Agent Run State**:
Runtime state created while an Agent Invocation is being processed.
_Avoid_: Chat state, workflow state

**Concurrent Invocation Guard**:
Internal Agent behavior that prevents overlapping invocations from mutating the same Agent Run State.
_Avoid_: Public lock API, Capability

**Development State Provider**:
An in-memory or local provider used only for single-process Agent development.
_Avoid_: Production state provider, durable coordination

## Relationships

- An **Agent Definition** declares one **Agent**.
- An **Agent** receives zero or more **Agent Invocations**.
- An **Agent** can attach zero or more Capabilities.
- Tools are contributed by Capabilities, not by top-level Agent Definition fields.
- An **Agent Invocation** can create or update **Agent Run State**.
- A **Concurrent Invocation Guard** protects **Agent Run State**.
- A **Development State Provider** is not acceptable for hosted production runtimes.

## Example Dialogue

> **Dev:** "Should users configure `tools` directly on the Agent Definition?"
> **Domain expert:** "No. Tools belong inside Capability definitions so validation, policy, and DevTools metadata stay attached to the Capability."

## Flagged Ambiguities

- Raw tools were considered as top-level Agent Definition fields - resolved: tools are contributed by Capabilities.
- Chat runtime state was considered a public Chat option - resolved: use **Agent Run State** for Agent-owned runtime state.
- Local and hosted state providers were considered equivalent - resolved: hosted production runtimes require a durable provider and a **Concurrent Invocation Guard**.

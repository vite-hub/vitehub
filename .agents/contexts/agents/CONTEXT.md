# Agents

Agents names definitions, invocations, and agent-owned runtime behavior.

## Language

**Agent**:
A named server-side actor that receives inputs, runs model-backed behavior, and may attach Capabilities.
_Avoid_: Bot, chat definition, workflow

**Agent Definition**:
The code declaration that names an Agent and configures its model, workspace, tools, instructions, and Capabilities.
_Avoid_: Chat definition, server route

**Agent Invocation**:
One runtime request to an Agent.
_Avoid_: Chat message, webhook call

**Agent Runtime Behavior**:
Internal behavior that an Agent or Capability needs to process invocations correctly.
_Avoid_: User-facing Capability, public adapter

**Invocation Coordination**:
Agent Runtime Behavior that prevents conflicting concurrent invocations for the same coordination scope.
_Avoid_: Chat lock, public lock API

**Best-Effort Coordination**:
Invocation Coordination that is acceptable only for local or single-process development.
_Avoid_: Production lock, durable coordination

## Relationships

- An **Agent Definition** declares one **Agent**.
- An **Agent** receives zero or more **Agent Invocations**.
- An **Agent** can attach zero or more Capabilities.
- **Agent Runtime Behavior** is internal unless exposed by a named Capability or primitive.
- **Invocation Coordination** is **Agent Runtime Behavior**.
- **Best-Effort Coordination** is not acceptable for hosted production runtimes.

## Example Dialogue

> **Dev:** "Should users configure a lock adapter on the agent?"
> **Domain expert:** "No. That is **Agent Runtime Behavior**. If it becomes public, it needs a named ViteHub primitive or Capability boundary."

## Flagged Ambiguities

- Chat runtime state was considered a public Chat option - resolved: runtime coordination is **Agent Runtime Behavior** unless exposed through a named public boundary.
- Local and hosted coordination were considered equivalent - resolved: hosted production runtimes require guaranteed **Invocation Coordination**; local single-process development can use **Best-Effort Coordination** with diagnostics.

# Capabilities

Capabilities are user-shareable abilities that ViteHub agents can attach through `defineAgent({ capabilities })`.

## Language

**Capability**:
A shareable ViteHub bundle that adds a named agent ability.
_Avoid_: Plugin, integration, extension

**Capability Definition**:
The object shape, returned by a factory or written inline, that declares a Capability's id, instructions, tools, metadata, mode, and requirements.
_Avoid_: Raw tool, config mutator

**Capability Lifecycle**:
The ordered process that validates requirements, applies capability contributions, and exposes resulting instructions, tools, policy, and metadata to the Agent.
_Avoid_: Random hook, raw setup

**Capability Requirement**:
A primitive, workspace mode, or workspace path that a Capability needs before it can be applied to an Agent.
_Avoid_: Capability dependency, plugin dependency

**Chat Capability**:
A Capability that gives an Agent chat-oriented runtime behavior, including Chat History for the current stack.
_Avoid_: Chat History Capability, Agent Memory

**Workspace Capability**:
A Capability that gives an Agent model-facing access to Workspace files.
_Avoid_: Bash, raw workspace tools, built-in tool

**Workspace Shell Capability**:
A Workspace Capability that exposes shell-shaped Workspace inspection and optional structured Workspace mutation tools.
_Avoid_: Bash, sandbox, raw workspace tools

## Relationships

- An Agent attaches zero or more **Capabilities**.
- Official helpers such as `skills()`, `mcp()`, `workspaceShell()`, `sandbox()`, `kv()`, `blob()`, and `db()` create **Capability Definitions**.
- A **Chat Capability** owns Chat History behavior for the current stack.
- A **Workspace Capability** contributes Workspace tools without implying unrestricted process execution.
- A **Workspace Shell Capability** contributes shell-shaped Workspace tools without implying Sandbox execution.
- Chat History is not a standalone **Capability** in the current stack.
- Agent Memory is a separate Capability concern from the **Chat Capability**.
- User-defined Capabilities use the same **Capability Definition** shape as official helpers.
- A **Capability Definition** can contribute instructions, tools, policy, and metadata.
- A **Capability** can declare **Capability Requirements**.
- The **Capability Lifecycle** validates **Capability Requirements** as early as possible.
- Tools are exposed through **Capability Definitions**, not through top-level Agent Definition fields.

## Example Dialogue

> **Dev:** "Should DB access be a raw tool on the agent?"
> **Domain expert:** "No. Expose it through a **Capability Definition** with requirements and policy."

## Flagged Ambiguities

- "plugin" was used to mean both framework plugins and user-shareable ViteHub abilities - resolved: use **Capability** for the agent ability concept.
- Tool-first surfaces were considered the primary model - resolved: tools are one contribution of a **Capability Definition**.
- Capability phases, contexts, hooks, and instruction slots were considered glossary terms - resolved: group that detail under **Capability Lifecycle** unless a feature needs a sharper term.
- Chat History was considered as a standalone Capability - resolved: keep Chat History inside the **Chat Capability** for this stack and revisit during a future Agent Memory pass.
- Agent Memory was considered dependent on the Chat Capability - resolved: stack Agent Memory directly on the capability runtime because memory and chat are separate Capability concerns.
- Workspace inspection was considered a hand-written raw tool contribution or Bash concern - resolved: expose it through a **Workspace Capability**.
- `bash()` was considered as the public helper for Workspace file access - resolved: use `workspaceShell()` for the **Workspace Shell Capability** because the shell is scoped to Workspace files.

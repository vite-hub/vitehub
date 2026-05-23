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

**Storage Capability Tool Surface**:
The two-tool read/edit shape used by official storage Capabilities to expose scoped storage operations to a model.
_Avoid_: Primitive method proxy, storage method fanout

**Schema Mode**:
The DB Capability permission axis that controls model-facing access to schema inspection or schema changes.
_Avoid_: modeSchema, access

**Autonomous Storage Writes**:
An explicit storage Capability policy choice that lets model-facing write tools mutate storage without per-call approval.
_Avoid_: Implicit write permission, yolo mode

**Single-Statement SQL Guardrail**:
The DB Capability rule that accepts one SQL statement per tool call and rejects multi-statement or transaction-shaped SQL.
_Avoid_: Agent migration batch, SQL script

**Chat Capability**:
A Capability that gives an Agent chat-oriented runtime behavior, including Chat History for the current stack.
_Avoid_: Chat History Capability, Agent Memory

**Workspace Capability**:
A Capability that gives an Agent model-facing access to Workspace files through inspect or write tools.
_Avoid_: Bash, raw workspace tools, built-in tool

**Transcription**:
An Official Capability that turns audio input parts into transcript text before an Agent runs.
_Avoid_: Voice Input, audio support, voice plugin

**Input Command**:
A Capability-provided command that transforms or enriches explicit user input before an Agent runs.
_Avoid_: Slash Command, chat command, shell command, model tool

**Host Command**:
A host-owned command that changes chat, session, UI, or product state around an Agent.
_Avoid_: Input Command, Capability, model tool

## Relationships

- An Agent attaches zero or more **Capabilities**.
- Official helpers such as `skills()`, `transcribe()`, `mcp()`, `bash()`, `sandbox()`, `kv()`, `blob()`, and `db()` create **Capability Definitions**.
- An **Input Command** is a **Capability** concern resolved before model-facing Agent behavior.
- A **Host Command** is not an **Input Command** and is outside the Capability Lifecycle.
- Primitive storage helpers such as `kv()`, `blob()`, and `db()` are first-class official **Capabilities**, not sample raw-tool wrappers.
- A **Chat Capability** owns Chat History behavior for the current stack.
- **Transcription** is an input-phase Official Capability.
- A **Workspace Capability** contributes Workspace tools without implying shell access.
- Chat History is not a standalone **Capability** in the current stack.
- Agent Memory is a separate Capability concern from the **Chat Capability**.
- User-defined Capabilities use the same **Capability Definition** shape as official helpers.
- A **Capability Definition** can contribute instructions, tools, policy, and metadata.
- A **Capability Definition** uses `id` as its only capability-level identity and display label.
- A **Capability** can declare **Capability Requirements**.
- The **Capability Lifecycle** validates **Capability Requirements** as early as possible.
- Tools are exposed through **Capability Definitions**, not through top-level Agent Definition fields.
- An **Input Command** exposes user-facing command descriptions for host rendering without making those descriptions part of command identity.
- Official storage Capabilities use a **Storage Capability Tool Surface** instead of one tool per primitive method.
- The DB Capability has data `mode` and **Schema Mode** as separate permission axes.
- Storage write tools require approval by default unless the developer opts into **Autonomous Storage Writes**.
- The DB Capability uses one edit tool for data and schema mutations, with permission checks based on the SQL statement.
- DB storage tools use database-native names (`db_schema`, `db_query`, `db_exec`) while KV and Blob use read/edit names.
- Primitive storage Capabilities wrap configured primitive handles from the Capability context.
- The DB Capability applies the **Single-Statement SQL Guardrail** to query and exec tools.

## Example Dialogue

> **Dev:** "Should DB access be a raw tool on the agent?"
> **Domain expert:** "No. Expose it through a **Capability Definition** with requirements and policy."
>
> **Dev:** "Is `/review` a chat feature or a shell command?"
> **Domain expert:** "No. It is an **Input Command** when a Capability transforms the explicit user input before the Agent runs."
>
> **Dev:** "Should `/clear` be an Input Command?"
> **Domain expert:** "No. `/clear` is a **Host Command** because it changes chat or session state instead of Agent run input."

## Flagged Ambiguities

- "plugin" was used to mean both framework plugins and user-shareable ViteHub abilities - resolved: use **Capability** for the agent ability concept.
- Tool-first surfaces were considered the primary model - resolved: tools are one contribution of a **Capability Definition**.
- Capability phases, contexts, hooks, and instruction slots were considered glossary terms - resolved: group that detail under **Capability Lifecycle** unless a feature needs a sharper term.
- Chat History was considered as a standalone Capability - resolved: keep Chat History inside the **Chat Capability** for this stack and revisit during a future Agent Memory pass.
- Agent Memory was considered dependent on the Chat Capability - resolved: stack Agent Memory directly on the capability runtime because memory and chat are separate Capability concerns.
- Workspace inspection was considered a hand-written raw tool contribution or Bash concern - resolved: expose it through a **Workspace Capability**.
- "audio input", "voice input", and "voice transcription" were considered as names for spoken user messages - resolved: use **Transcription** for the capability.
- Capability-level name and description were considered separate display metadata - resolved: remove both as a breaking change and use **Capability** id as the only capability-level identity/display field.
- Slash command was considered as the domain term - resolved: use **Input Command** for the Capability concept because it names the lifecycle position; slash syntax is only the initial invocation format.
- Host/session commands were considered part of Input Commands - resolved: **Host Commands** are a separate future concern because they change chat, session, UI, or product state rather than Agent run input.
- Input Command display metadata was considered capability-level - resolved: Capability id owns identity, while command descriptions are the user-facing metadata hosts may render.
- Storage Capability options were described as access levels in an older PR - resolved: official primitive Capabilities use `mode` for read/write exposure, while `access` is older proposal language.
- Storage helpers were considered examples around raw tools - resolved: KV, Blob, and DB helpers are first-class official **Capabilities**.
- Storage Capabilities were considered as direct primitive method proxies - resolved: official storage Capabilities should stay small with read/edit tools rather than method fanout.
- DB storage permission was considered one mode - resolved: DB separates data `mode` from **Schema Mode** because data reads/writes and schema inspection/changes are different authorities.
- Storage write mode was considered enough to allow immediate mutations - resolved: write exposure and approval policy are separate, so developers can opt into **Autonomous Storage Writes** explicitly.
- DB schema writes were considered for a separate edit tool - resolved: keep one DB edit tool and classify SQL statements against data `mode` and **Schema Mode**.
- DB tools were considered for read/edit naming to match KV and Blob - resolved: use `db_query` and `db_exec` because SQL agents and database tooling already use query/execute language.
- Primitive storage Capabilities were considered for direct runtime package imports - resolved: wrap configured primitive handles from the Capability context so primitive configuration remains outside the Agent Package.
- Agent-managed database changes were considered for multi-statement migration batches - resolved: v1 DB tools require one SQL statement per tool call and reject transaction-shaped SQL.

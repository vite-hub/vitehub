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

**Capability Trigger Contribution**:
A Capability-owned server-side contribution that registers Agent Trigger behavior for a product event.
_Avoid_: Chat helper, DevTools bridge, raw server route, server-only bucket

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
A Capability that gives an Agent model-facing access to Workspace files.
_Avoid_: Bash, raw workspace tools, built-in tool

**Web Search Capability**:
A Capability that gives an Agent model-facing access to web search results and normalized URL content.
_Avoid_: askweb capability, web plugin, search integration

**Web Search Mode**:
The required developer-selected execution strategy for a Web Search Capability.
_Avoid_: Implicit web behavior, auto mode, provider type

**Model Web Search Mode**:
A Web Search Mode that asks the selected Agent Model Adapter to enable the model provider's built-in web search facility.
_Avoid_: Native search, adapter search, provider value

**Model Web Search Output**:
The web-search-related sources, citations, provider metadata, warnings, and raw fields returned by an Agent Model Adapter in Model Web Search Mode.
_Avoid_: Web Search Result, Web Read Result, normalized tool output

**Web Search Result**:
A normalized structured result returned by a web search operation.
_Avoid_: HTML page, provider result, raw response

**Web Search Input**:
The camelCase structured input accepted by the web search tool in tool-based Web Search Mode.
_Avoid_: Provider raw params, snake_case input

**Web Read Result**:
A normalized structured content record returned by reading one URL.
_Avoid_: Scraped HTML, page dump, raw response

**Web Search Provider Policy**:
The developer-owned rule that selects the single web search provider a Web Search Capability may use.
_Avoid_: Auto provider choice, model provider choice, provider fan-out, raw provider passthrough

**Web Read Provider**:
The internal provider used by a Web Search Capability to read normalized URL content.
_Avoid_: Model-selected read provider, search provider requirement

**Web Search Credential Source**:
An allowed origin for a Web Search Capability provider credential.
_Avoid_: Vite env var, Nitro env var, browser env

**Transcription**:
An Official Capability that turns audio input parts into transcript text before an Agent runs.
_Avoid_: Voice Input, audio support, voice plugin

**Workspace Shell Capability**:
A Workspace Capability that exposes shell-shaped Workspace inspection and optional structured Workspace mutation tools.
_Avoid_: Bash, sandbox, raw workspace tools

**MCP Capability**:
A Capability that connects an Agent to external MCP servers and exposes their model-facing tools.
_Avoid_: MCP server implementation, MCP Source

**MCP Server**:
An external Model Context Protocol server consumed by an Agent through the MCP Capability.
_Avoid_: ViteHub-hosted server, Workspace Source

**Input Command**:
A Capability-provided command that transforms or enriches explicit user input before an Agent runs.
_Avoid_: Slash Command, chat command, shell command, model tool

**Host Command**:
A host-owned command that changes chat, session, UI, or product state around an Agent.
_Avoid_: Input Command, Capability, model tool

## Relationships

- An Agent attaches zero or more **Capabilities**.
- Official helpers such as `skills()`, `transcribe()`, `mcp()`, `workspaceShell()`, `sandbox()`, `kv()`, `blob()`, `db()`, and `webSearch()` create **Capability Definitions**.
- Official helpers should map to product abilities rather than implementation mechanisms.
- A **Capability Definition** may provide a **Capability Trigger Contribution** when the ability needs to start Agent Invocations from a product event.
- A **Capability Trigger Contribution** is composed from `defineAgent({ capabilities })`, not registered through a separate helper.
- A **Capability Trigger Contribution** belongs directly to the Capability shape unless a broader grouping earns its name later.
- A **Capability Trigger Contribution** maps product event input into Agent Invocation input and run metadata; Agent execution remains owned by the Agent Package.
- An **Input Command** is a **Capability** concern resolved before model-facing Agent behavior.
- A **Host Command** is not an **Input Command** and is outside the Capability Lifecycle.
- Primitive storage helpers such as `kv()`, `blob()`, and `db()` are first-class official **Capabilities**, not sample raw-tool wrappers.
- A **Chat Capability** owns Chat History behavior for the current stack.
- **Transcription** is an input-phase Official Capability.
- A **Workspace Capability** contributes Workspace tools without implying unrestricted process execution.
- A **Workspace Shell Capability** contributes shell-shaped Workspace tools without implying Sandbox execution.
- An **MCP Capability** consumes one or more external **MCP Servers**.
- A **Web Search Capability** hides its underlying search library from users and model-facing labels.
- A **Web Search Capability** requires an explicit **Web Search Mode** in the first version.
- A tool-based **Web Search Mode** exposes web search and URL reading as ordinary ViteHub tools.
- **Model Web Search Mode** uses Agent Model Adapter support and does not expose URL reading.
- **Model Web Search Mode** preserves **Model Web Search Output** through the normal Agent result path when the selected Agent Model Adapter exposes it.
- A tool-based **Web Search Capability** exposes web search and URL reading as separate model-facing tools.
- A **Web Search Capability** returns **Web Search Results** and **Web Read Results** as structured data instead of raw HTML.
- A tool-based **Web Search Capability** uses camelCase **Web Search Input** fields while keeping tool names consistent with existing ViteHub tool naming.
- A **Web Search Capability** uses a **Web Search Provider Policy** to keep provider choice under developer control by default.
- A **Web Search Provider Policy** explicitly selects exactly one search provider in the first version.
- A **Web Read Provider** is fixed internally in the first version and is not selected by the model.
- A **Web Search Capability** resolves provider secrets through **Web Search Credential Sources**.
- **Web Search Credential Sources** prefer explicit Secret Env resolvers, then ViteHub-scoped provider env vars, then canonical provider env vars.
- A **Web Read Result** defaults to normalized Markdown content, with plain text available when requested.
- **Model Web Search Mode** is adapter-gated; TanStack AI is not supported for model mode in the first version.
- A tool search provider and **Web Search Mode** are separate axes; provider is only used by tool-based **Web Search Mode**.
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
>
> **Dev:** "Should Chat DevTools wire its own chat send helper?"
> **Domain expert:** "No. The **Chat Capability** should provide a **Capability Trigger Contribution**, and DevTools should consume the resolved Agent Trigger."

## Flagged Ambiguities

- "plugin" was used to mean both framework plugins and user-shareable ViteHub abilities - resolved: use **Capability** for the agent ability concept.
- "askweb" was considered as the user-facing capability name - resolved: use **Web Search Capability** and keep the underlying library as an implementation detail.
- Raw HTML was considered as a model-facing read response - resolved: return structured **Web Read Results** with normalized Markdown or text content.
- Separate `webSearch()` and `nativeWebSearch()` helpers were considered - resolved: use one **Web Search Capability** with explicit **Web Search Mode**.
- Defaulting **Web Search Mode** was considered - resolved: require the developer to choose tool or model mode in the first version.
- "native" was considered as a **Web Search Mode** name - resolved: use **Model Web Search Mode** because native is overloaded across adapters, model providers, and platforms.
- `nativeModel` was considered as a provider value - resolved: keep model search as **Web Search Mode**, not a tool search provider.
- Normalizing **Model Web Search Output** into tool-mode result shapes was considered - resolved: preserve adapter/provider output as much as possible without promising cross-provider normalized search or read data.
- Snake_case web search input fields were considered - resolved: use camelCase input fields for structured tool arguments.
- Model-mode support for TanStack AI was considered - resolved: fail early for TanStack AI until ViteHub has an adapter-native provider-tool contribution path.
- Model-controlled provider choice, automatic provider choice, and provider fan-out were considered - resolved: provider choice belongs to explicit **Web Search Provider Policy**, and the first version selects one provider only.
- Requiring the selected search provider to also own URL reading was considered - resolved: search provider policy and **Web Read Provider** are separate in the first version.
- Model-facing provider reachability was considered - resolved: keep provider reachability developer-facing in the first version.
- `VITE_*` and `NITRO_*` provider credential names were considered - resolved: reject them for **Web Search Credential Sources**; `VITE_*` is browser-exposed Vite language, and `NITRO_*` is framework runtime-config language rather than Capability credential language.
- Tool-first surfaces were considered the primary model - resolved: tools are one contribution of a **Capability Definition**.
- Chat-specific helpers were considered for server-side trigger behavior - resolved: use **Capability Trigger Contribution** so Chat and future user-defined Capabilities register Agent Triggers from the Agent config source of truth.
- Grouping trigger contributions under a `server` bucket was considered - resolved: keep triggers directly capability-owned because Agent Triggers are server-authoritative by default and no broader server contribution group has been proven yet.
- Trigger handlers were considered for direct Agent execution - resolved: trigger contributions map input and run metadata, while the Agent Package executes the Agent Invocation through the standard lifecycle.
- Capability phases, contexts, hooks, and instruction slots were considered glossary terms - resolved: group that detail under **Capability Lifecycle** unless a feature needs a sharper term.
- Chat History was considered as a standalone Capability - resolved: keep Chat History inside the **Chat Capability** for this stack and revisit during a future Agent Memory pass.
- Agent Memory was considered dependent on the Chat Capability - resolved: stack Agent Memory directly on the capability runtime because memory and chat are separate Capability concerns.
- Workspace inspection was considered a hand-written raw tool contribution or Bash concern - resolved: expose it through a **Workspace Capability**.
- "audio input", "voice input", and "voice transcription" were considered as names for spoken user messages - resolved: use **Transcription** for the capability.
- `bash()` was considered as the public helper for Workspace file access - resolved: use `workspaceShell()` for the **Workspace Shell Capability** because the shell is scoped to Workspace files.
- MCP server language was considered ambiguous between hosting an MCP server and consuming one - resolved: in the **MCP Capability**, an **MCP Server** is external and consumed by an Agent.
- Capability-level name and description were considered separate display metadata - resolved: remove both as a breaking change and use **Capability** id as the only capability-level identity/display field.
- Slash command was considered as the domain term - resolved: use **Input Command** for the Capability concept because it names the lifecycle position; slash syntax is only the initial invocation format.
- Host/session commands were considered part of Input Commands - resolved: **Host Commands** are a separate future concern because they change chat, session, UI, or product state rather than Agent run input.
- Input Command display metadata was considered capability-level - resolved: Capability id owns identity, while command descriptions are the user-facing metadata hosts may render.
- Requiring users to attach one Capability per internal mechanism was considered - resolved: users attach one Capability per product ability, and official Capabilities can own their natural Input Command surface when that command is part of the expected user experience.
- Storage Capability options were described as access levels in an older PR - resolved: official primitive Capabilities use `mode` for read/write exposure, while `access` is older proposal language.
- Storage helpers were considered examples around raw tools - resolved: KV, Blob, and DB helpers are first-class official **Capabilities**.
- Storage Capabilities were considered as direct primitive method proxies - resolved: official storage Capabilities should stay small with read/edit tools rather than method fanout.
- DB storage permission was considered one mode - resolved: DB separates data `mode` from **Schema Mode** because data reads/writes and schema inspection/changes are different authorities.
- Storage write mode was considered enough to allow immediate mutations - resolved: write exposure and approval policy are separate, so developers can opt into **Autonomous Storage Writes** explicitly.
- DB schema writes were considered for a separate edit tool - resolved: keep one DB edit tool and classify SQL statements against data `mode` and **Schema Mode**.
- DB tools were considered for read/edit naming to match KV and Blob - resolved: use `db_query` and `db_exec` because SQL agents and database tooling already use query/execute language.
- Primitive storage Capabilities were considered for direct runtime package imports - resolved: wrap configured primitive handles from the Capability context so primitive configuration remains outside the Agent Package.
- Agent-managed database changes were considered for multi-statement migration batches - resolved: v1 DB tools require one SQL statement per tool call and reject transaction-shaped SQL.

# Capabilities

Capabilities are user-shareable abilities that ViteHub agents can attach through `defineAgent({ capabilities })`.

## Language

**Capability**:
A shareable ViteHub bundle that adds a named agent ability.
_Avoid_: Plugin, integration, extension

**Capability Definition**:
The object shape, returned by a factory or written inline, that declares a Capability's id, instructions, tools, metadata, mode, and requirements.
_Avoid_: Raw tool, config mutator

**Capability Type Contract**:
A narrow type-only contract an official Capability declares for Agent Definition inputs it directly consumes.
_Avoid_: Generic helper, runtime preparation, ambient app type, custom Capability framework

**Capability Lifecycle**:
The ordered process that validates requirements, applies capability contributions, and exposes resulting instructions, tools, policy, and metadata to the Agent.
_Avoid_: Random hook, raw setup

**Capability Trigger Contribution**:
A Capability-owned server-side contribution that registers Agent Trigger behavior for a product event.
_Avoid_: Chat helper, DevTools bridge, raw server route, server-only bucket

**Entry Capability**:
A small official Capability created by `entry()` that lets an Agent receive app-owned product events through Capability Trigger Contributions and trusted Chat App Route exposure.
_Avoid_: Chat App Capability, route helper, trigger helper

**Capability Requirement**:
A primitive, workspace mode, or workspace path that a Capability needs before it can be applied to an Agent.
_Avoid_: Capability dependency, plugin dependency

**Prompt Template**:
A Capability-owned text template that renders model-facing prompt text from named Prompt Template Variables.
_Avoid_: Dynamic prompt, hardcoded prompt, prompt callback

**Prompt Template Variable**:
A named value available when rendering a Prompt Template.
_Avoid_: Placeholder, interpolation value, prompt arg

**Audience Capability**:
A Capability created by `audience()` that contributes model-facing instruction blocks for the selected invocation audience.
_Avoid_: Access Role, model role, user profile, prompt middleware

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

**Chat Platform Adapter**:
A ChatSDK adapter returned by Chat Capability configuration for an external chat platform such as Teams.
_Avoid_: Agent Model Execution, Agent Trigger, Nitro handler

**Chat Adapter Package**:
An optional integration package that constructs a Chat Platform Adapter or Chat Capability state backend, such as `@chat-adapter/teams` or `@chat-adapter/state-pg`.
_Avoid_: Built-in Capability, Agent Package dependency, generated adapter export

**Chat Adapter Facade**:
A narrow ViteHub-owned import subpath for a first-party-supported Chat Adapter Package when ViteHub owns a stable shim and missing-package diagnostics.
_Avoid_: Adapter barrel, generated upstream re-export, root Agent Package export

**Chat Adapter Callback**:
The lazy Chat Capability option that returns the current request's Chat Platform Adapters.
_Avoid_: Webhook registration helper, adapter registry, build-time adapter scan

**Chat Webhook Autowiring**:
ViteHub-owned server wiring that exposes Chat Platform Adapter webhooks from the Chat Capability without app route code.
_Avoid_: Public registration function, local Teams route, manual webhook route

**Workspace Capability**:
A Capability that gives an Agent model-facing access to Workspace files.
_Avoid_: Bash, raw workspace tools, built-in tool

**Access Capability**:
A Capability created by `access()` that resolves trusted invocation access and applies allow-only access boundaries to configured runtime surfaces, starting with Workspace Scope.
_Avoid_: Organization Capability, Workspace Definition mutator, dynamic Source, dynamic Capability

**Access Role**:
A named bundle of permissions and scope-selection authority used by the Access Capability.
_Avoid_: Workspace Rule, Capability mode, model role

**Web Search Capability**:
A Capability that gives an Agent model-facing access to web search results and normalized URL content.
_Avoid_: askweb capability, web plugin, search integration

**Web Search Mode**:
The required developer-selected execution strategy for a Web Search Capability.
_Avoid_: Implicit web behavior, auto mode, provider type

**Model Web Search Mode**:
A Web Search Mode that asks Agent Model Execution to enable the model provider's built-in web search facility.
_Avoid_: Native search, adapter search, provider value

**Model Web Search Output**:
The web-search-related sources, citations, provider metadata, warnings, and raw fields returned through Agent Model Execution in Model Web Search Mode.
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

**Transcription Artifacts**:
Transcription Capability artifact persistence into the Agent's writable Workspace, configured through `transcribe({ artifacts })`.
_Avoid_: Capability Workspace, provider response format, output hook

**Transcript Workspace Path**:
The Workspace path of the transcript artifact configured by `artifacts.transcript.path`.
_Avoid_: Output directory, extension, local filesystem path

**Audio Artifact**:
The optional persisted source-audio artifact for Transcription Artifacts, either derived beside the Transcript Workspace Path or explicitly configured through `artifacts.audio.path`.
_Avoid_: Second transcript path, provider audio output

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

**Pre-Invocation Decision**:
An internal structured decision made before the main Agent Invocation proceeds, used by Capabilities to record a typed context value, reject, or select Chat Session behavior.
_Avoid_: Generic middleware, dynamic Capability, arbitrary input context

**LLM Route Capability**:
A Capability that asks an LLM to choose one developer-defined option and records the chosen route as a typed Pre-Invocation Decision.
_Avoid_: Routing Capability, callback routing, model router

**LLM Gate Capability**:
A Capability that asks an LLM to classify a request against developer-defined allow and reject categories and may reject before the main Agent Invocation proceeds.
_Avoid_: Gate, auth gate, security gate, deterministic guard

## Relationships

- An Agent attaches zero or more **Capabilities**.
- Official helpers such as `entry()`, `audience()`, `skills()`, `transcribe()`, `mcp()`, `workspaceShell()`, `access()`, `sandbox()`, `kv()`, `blob()`, `db()`, `webSearch()`, `llmRoute()`, and `llmGate()` create **Capability Definitions**.
- Official Capability factories and Capability-owned helper functions are imported from `@vite-hub/agent/capabilities`, not from the root `@vite-hub/agent` Agent Package entry.
- Official helpers should map to product abilities rather than implementation mechanisms.
- An official **Capability Definition** may carry a narrow **Capability Type Contract** when it directly consumes typed Agent Definition inputs such as Source keys, trusted Chat Capability origins, or schema-validated invocation context.
- A **Capability Type Contract** checks developer configuration at Agent Definition time; it does not grant runtime authority or act as a generic invocation-context schema system.
- A **Capability Definition** may provide a **Capability Trigger Contribution** when the ability needs to start Agent Invocations from a product event.
- A **Capability Trigger Contribution** is composed from `defineAgent({ capabilities })`, not registered through a separate helper.
- A **Capability Trigger Contribution** belongs directly to the Capability shape unless a broader grouping earns its name later.
- A **Capability Trigger Contribution** maps product event input into Agent Invocation input and run metadata; Agent execution remains owned by the Agent Package.
- An **Entry Capability** is the official small helper for app-owned product events when a full product-specific Capability has not earned a name yet.
- An **Entry Capability** may expose a trusted Chat App Route origin without adding app-route fields to Chat Capability options.
- A **Prompt Template** belongs to the Capability that renders it and should expose only the **Prompt Template Variables** that are stable for that Capability.
- An **Audience Capability** contributes prompt instructions; it does not apply access boundaries.
- Standard Schema validation is the preferred runtime boundary for app-owned invocation metadata that an official **Capability** directly consumes.
- An **Input Command** is a **Capability** concern resolved before model-facing Agent behavior.
- A **Host Command** is not an **Input Command** and is outside the Capability Lifecycle.
- A **Pre-Invocation Decision** is an internal primitive used by Capabilities before the main Agent Invocation.
- A **Pre-Invocation Decision** can expose a typed invocation context value, reject the invocation, record an inspectable decision, or select Chat Session behavior.
- A **Pre-Invocation Decision** does not dynamically attach, remove, or grant **Capabilities**.
- Pre-Invocation Decision ids are unique per Agent; duplicate ids fail early instead of merging, prioritizing, or using last-write-wins behavior.
- An **LLM Route Capability** chooses one developer-defined option through an LLM and records the route decision. It does not apply route effects directly.
- An **LLM Gate Capability** chooses one developer-defined allow or reject category through an LLM and may reject before the main Agent Invocation.
- Deterministic or callback-based routing is not an official Capability in V1; users can define inline Capabilities or hooks that set named invocation context values.
- Primitive storage helpers such as `kv()`, `blob()`, and `db()` are first-class official **Capabilities**, not sample raw-tool wrappers.
- A **Chat Capability** owns Chat History behavior for the current stack.
- A **Chat Capability** may declare **Chat Platform Adapters** through a **Chat Adapter Callback**.
- A **Chat Capability** carries trusted Chat Capability origins from its Chat Platform Adapter names.
- An **Entry Capability** carries trusted Chat Capability origins from its Chat App Route origin and a linked Chat Capability's Chat Platform Adapter names.
- A **Chat Capability** provides a platform-scoped **Chat Identity** default for Chat Platform Adapter messages when transcript persistence needs one.
- A **Chat Platform Adapter** may come from a **Chat Adapter Package** that remains an explicit optional application dependency.
- The Agent Package should not generate exports for every **Chat Adapter Package**.
- A **Chat Adapter Facade** is reserved for first-party-supported adapters where ViteHub owns the public compatibility surface.
- A **Chat Capability** can contribute trusted chat actor identity into Agent Invocation Context Values before later Capabilities resolve.
- **Chat Platform Adapters** are platform integration adapters, not **Agent Model Execution**.
- **Chat Webhook Autowiring** is inferred from the Agent's attached **Chat Capability**; users do not attach a second Capability or call a webhook registration helper.
- **Chat Webhook Autowiring** resolves the **Chat Adapter Callback** at request time so callbacks can read Server Env and other request-local server state.
- **Transcription** is an input-phase Official Capability.
- **Transcription Artifacts** consume an already-declared writable Workspace; they do not define, mutate, or replace the Agent's Workspace.
- A **Transcript Workspace Path** is the canonical destination for persisted transcript artifacts; directory, stem, and extension are derived from that path instead of configured as separate public fields.
- An **Audio Artifact** is disabled or relocated through `artifacts.audio`; when enabled without an explicit path, it is derived from the **Transcript Workspace Path**.
- Transcription Artifacts expose a sanitized default `stem` to path callbacks so platform message ids do not leak unsafe Workspace path characters.
- Provider transcription response format and **Transcription Artifacts** media type are separate concerns.
- A **Workspace Capability** contributes Workspace tools without implying unrestricted process execution.
- An **Access Capability** applies invocation-time access rules without mutating Workspace Definitions or granting new Capabilities dynamically.
- The `access()` helper creates an **Access Capability**.
- In the first version, an **Access Capability** applies **Workspace Scope** only.
- An **Access Capability** can record the active Workspace Scope as an Agent Invocation Context Value for later callbacks and instructions.
- An **Access Capability** owns both Workspace Scope selection and application, but keeps resolver logic separate from grants.
- An **Access Capability** may consume an **Invocation Profile** to select Workspace Scope without owning the profile resolution.
- An **Access Capability** may reference a **Chat Capability** for typed origin context instead of asking users to repeat Chat Capability origins in Access configuration.
- An **Access Capability** can use static named Workspace Scopes or an inline Workspace Scope definition returned by its resolver.
- An **Access Capability** must be ordered before other Workspace-reading Capabilities so Workspace Scope is applied before they resolve tools or requirements.
- An **Access Capability** provides tiny default **Access Roles** for the first version.
- The default `viewer` **Access Role** can read granted Source keys and path prefixes through Workspace Scope Grants.
- The default `admin` **Access Role** can select the explicit all-scopes mode when the developer configured that mode.
- A **Workspace Shell Capability** contributes shell-shaped Workspace tools without implying Sandbox execution.
- An **MCP Capability** consumes one or more external **MCP Servers**.
- A **Web Search Capability** hides its underlying search library from users and model-facing labels.
- A **Web Search Capability** requires an explicit **Web Search Mode** in the first version.
- A tool-based **Web Search Mode** exposes web search and URL reading as ordinary ViteHub tools.
- **Model Web Search Mode** uses Agent Model Execution support and does not expose URL reading.
- **Model Web Search Mode** preserves **Model Web Search Output** through the normal Agent result path when Agent Model Execution exposes it.
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
> **Dev:** "Can I add any request field to a Prompt Template?"
> **Domain expert:** "No. Use only the Prompt Template Variables exposed by that Capability, or provide a callback when the prompt needs custom runtime data."
>
> **Dev:** "Should technical-user answer style be an Access Role?"
> **Domain expert:** "No. Use an **Audience Capability** for model-facing style and keep **Access Role** for scope-selection authority."
>
> **Dev:** "Should Chat DevTools wire its own chat send helper?"
> **Domain expert:** "No. The **Chat Capability** should provide a **Capability Trigger Contribution**, and DevTools should consume the resolved Agent Trigger."
>
> **Dev:** "Should we expose a callback routing Capability?"
> **Domain expert:** "No. Use a user-defined **Capability Definition** or hook to set a named invocation context value; the official route helper is the **LLM Route Capability**."
>
> **Dev:** "Can an LLM route decision attach `workspaceShell()` for this one request?"
> **Domain expert:** "No. **Capabilities** are static and validated early. A route can influence instructions or other conditional contributions, but it cannot grant a new Capability."
>
> **Dev:** "Can `access()` read Source keys and chat metadata from the Agent Definition without app helper types?"
> **Domain expert:** "Yes, when the Capability declares a **Capability Type Contract**. The type contract checks the Agent Definition shape, while runtime trust still comes from explicit resolvers and validation."

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
- Public chat webhook registration helpers were considered for platform adapters - resolved: use **Chat Webhook Autowiring** from the **Chat Capability** so adapter configuration remains the only source of truth.
- Build-time Chat Platform Adapter detection was considered - resolved: resolve the **Chat Adapter Callback** at request time because platform credentials and adapter construction can depend on Server Env.
- Repeating Chat Capability origins in `access()` was considered - resolved: Invocation Profiles declare trusted chat origins explicitly, and Access consumes the resolved profile rather than owning chat input configuration.
- Capability phases, contexts, hooks, and instruction slots were considered glossary terms - resolved: group that detail under **Capability Lifecycle** unless a feature needs a sharper term.
- Chat History was considered as a standalone Capability - resolved: keep Chat History inside the **Chat Capability** for this stack and revisit during a future Agent Memory pass.
- Agent Memory was considered dependent on the Chat Capability - resolved: stack Agent Memory directly on the capability runtime because memory and chat are separate Capability concerns.
- Workspace inspection was considered a hand-written raw tool contribution or Bash concern - resolved: expose it through a **Workspace Capability**.
- Workspace Scope was considered as Workspace Definition mutation by a Capability - resolved: use an **Access Capability** to narrow an already-declared Workspace at invocation time instead of changing Sources or Workspace Rules.
- `workspaceScope()` was considered as the public helper name - resolved: use `access()` for the Capability while preserving **Workspace Scope** for the Workspace-specific boundary.
- `organization()` was considered as the public helper name - resolved: reject it because access decisions may come from organizations, customer domains, local config, or other trusted invocation context.
- Pre-registering every customer Workspace Scope was considered necessary - resolved: an Access Capability resolver may return an inline Workspace Scope definition for invocation-specific grants.
- Prompt audience was considered part of the **Access Capability** because it may use the same trusted identity facts - resolved: keep **Audience Capability** separate and let both capabilities consume an **Invocation Profile** when they need shared selection.
- Prompt audience variants were considered as roles - resolved: reserve **Access Role** for access authority and use audience language for model-facing instructions.
- "audio input", "voice input", and "voice transcription" were considered as names for spoken user messages - resolved: use **Transcription** for the capability.
- `transcribe({ workspace })` was considered for persisted transcript and audio artifacts - resolved: use **Transcription Artifacts** so the option does not masquerade as a Workspace Definition.
- Separate Transcription Artifacts `directory`, `stem`, and `extension` fields were considered - resolved: use a **Transcript Workspace Path** as the canonical destination and derive path parts internally.
- Compact `output.path` was considered for Transcription Artifacts - resolved: reject it because source audio is a first-class artifact and should be configured as a peer to `artifacts.transcript`.
- `bash()` was considered as the public helper for Workspace file access - resolved: use `workspaceShell()` for the **Workspace Shell Capability** because the shell is scoped to Workspace files.
- MCP server language was considered ambiguous between hosting an MCP server and consuming one - resolved: in the **MCP Capability**, an **MCP Server** is external and consumed by an Agent.
- Capability-level name and description were considered separate display metadata - resolved: remove both as a breaking change and use **Capability** id as the only capability-level identity/display field.
- Slash command was considered as the domain term - resolved: use **Input Command** for the Capability concept because it names the lifecycle position; slash syntax is only the initial invocation format.
- Host/session commands were considered part of Input Commands - resolved: **Host Commands** are a separate future concern because they change chat, session, UI, or product state rather than Agent run input.
- Generic `routing()` and `gate()` helpers were considered for LLM-backed decisions - resolved: use **LLM Route Capability** and **LLM Gate Capability** because the public names should make model use explicit and leave room for deterministic, auth, or security gates.
- A callback routing official Capability was considered - resolved: deterministic context decisions remain user-defined inline Capabilities or hooks in V1.
- Multiple route or gate decisions writing the same context key were considered for priority or merging - resolved: **Pre-Invocation Decision** ids are unique per Agent, with duplicate ids failing early.
- Dynamic Capability activation through route decisions was considered - resolved: Pre-Invocation Decisions can influence conditional contributions but must not attach, remove, or grant **Capabilities** at runtime.
- A generic `decisionPolicy()` helper and request-refinement Capability were considered - resolved: defer them until **LLM Route Capability**, **LLM Gate Capability**, and Chat Sessions prove the internal primitive.
- Typed capability preparation was considered as a runtime lifecycle phase - resolved: use narrow **Capability Type Contracts** for type-only Agent Definition checks on official Capabilities, and keep runtime validation inside the **Capability Lifecycle**.
- A generic custom-Capability contract framework was considered - resolved: defer it until user-defined Capabilities prove a stable story; the current contract exists for official Capabilities that directly consume Agent Definition inputs.
- Input Command display metadata was considered capability-level - resolved: Capability id owns identity, while command descriptions are the user-facing metadata hosts may render.
- Requiring users to attach one Capability per internal mechanism was considered - resolved: users attach one Capability per product ability, and official Capabilities can own their natural Input Command surface when that command is part of the expected user experience.
- Storage Capability options were described as access levels in an older PR - resolved: official primitive Capabilities use `mode` for read/write exposure, while `access` is older proposal language.
- Storage helpers were considered examples around raw tools - resolved: KV, Blob, and DB helpers are first-class official **Capabilities**.
- Root Agent Package exports were considered convenient for official Capability factories - resolved: keep official Capability factories and their companion helpers on `@vite-hub/agent/capabilities` so the root entry stays focused on Agent Definition and invocation primitives.
- Storage Capabilities were considered as direct primitive method proxies - resolved: official storage Capabilities should stay small with read/edit tools rather than method fanout.
- DB storage permission was considered one mode - resolved: DB separates data `mode` from **Schema Mode** because data reads/writes and schema inspection/changes are different authorities.
- Storage write mode was considered enough to allow immediate mutations - resolved: write exposure and approval policy are separate, so developers can opt into **Autonomous Storage Writes** explicitly.
- DB schema writes were considered for a separate edit tool - resolved: keep one DB edit tool and classify SQL statements against data `mode` and **Schema Mode**.
- DB tools were considered for read/edit naming to match KV and Blob - resolved: use `db_query` and `db_exec` because SQL agents and database tooling already use query/execute language.
- Primitive storage Capabilities were considered for direct runtime package imports - resolved: wrap configured primitive handles from the Capability context so primitive configuration remains outside the Agent Package.
- Agent-managed database changes were considered for multi-statement migration batches - resolved: v1 DB tools require one SQL statement per tool call and reject transaction-shaped SQL.

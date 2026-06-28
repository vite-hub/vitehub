# Capabilities

Capabilities are user-shareable abilities that ViteHub agents can attach through `defineAgent({ capabilities })`.

## Language

**Capability**:
A shareable ViteHub bundle that adds a named agent ability.
_Avoid_: Plugin, integration, extension

**Capability Definition**:
The object shape, returned by a factory or written inline, that declares a Capability's id, metadata, mode, requirements, and contributions.
_Avoid_: Raw tool, config mutator

**Capability Type Contract**:
A narrow type-only contract an official Capability declares for Agent Definition inputs it directly consumes.
_Avoid_: Generic helper, runtime preparation, ambient app type, custom Capability framework

**Capability Lifecycle**:
The ordered process that validates requirements, applies capability contributions, and exposes resulting policy, metadata, trigger behavior, and driver-facing inputs to the Agent.
_Avoid_: Random hook, raw setup

**Capability Trigger Contribution**:
A Capability-owned server-side contribution that registers Agent Trigger behavior for a product event.
_Avoid_: Chat helper, DevTools bridge, raw server route, server-only bucket

**Capability Driver Contribution**:
A Capability-owned contribution that may feed the active Agent Driver, such as model-facing instructions, model-facing tools, or an explicitly supported harness-compatible input.
_Avoid_: Raw tool, root instructions, implicit harness prompt, dynamic Capability

**Capability Instruction Coverage**:
Explicit Instruction Coverage for a configured Capability, authored in Agent Driver Instructions or deterministic imported instruction Markdown.
_Avoid_: Capability metadata, tool description, generated prompt hint

**Capability CLI Contribution**:
A Capability-owned real command tree declared on a Capability Definition and rendered into generated instruction guidance plus compatible Agent Driver or Agent Dev Loop execution surfaces.
_Avoid_: CLI Primitive, command builder, Input Command, Host Command, shell command, capabilityCli wrapper

**Workspace Shell Command Tool**:
The optional `workspaceShell({ commands })` model-facing tool that runs allowlisted executables inside a trusted Workspace Session.
_Avoid_: Separate public Workspace execution Capability, arbitrary shell, sandbox replacement

**Harness Workspace Path Contribution**:
A Capability-owned harness-compatible driver contribution that asks a harness-backed Agent Driver to materialize Capability support files from the Workspace.
_Avoid_: Workspace Scope Grant, Source grant, model instruction, root skill config

**Skill**:
A Workspace skill file or directory made available to an Agent through the `skills()` Capability.
_Avoid_: Root Agent Definition field, harness prompt, hidden tool bundle

**Skill Instruction Coverage**:
Explicit Instruction Coverage for a Skill made available by `skills()`, usually by binding the Skill path or a deterministic imported instruction file from Agent Driver Instructions.
_Avoid_: Skill discovery, generated skill hint, mounted file presence

**Capability Workspace Contribution**:
An add-only, invocation-scoped Capability contribution that adds inspectable Workspace Source Bindings or Workspace Rules before driver-facing Workspace surfaces are built.
_Avoid_: Workspace Definition mutator, hidden Source, dynamic Capability, output sink

**Capability Requirement**:
A primitive, workspace mode, or workspace path that a Capability needs before it can be applied to an Agent.
_Avoid_: Capability dependency, plugin dependency

**Prompt Template**:
A Capability-owned text template that renders model-facing prompt text from named Prompt Template Variables.
_Avoid_: Dynamic prompt, hardcoded prompt, prompt callback

**Prompt Template Variable**:
A named value available when rendering a Prompt Template.
_Avoid_: Placeholder, interpolation value, prompt arg

**MCP Prompt Template**:
A prompt template exposed by an MCP Server and consumed through Capability prompt or input behavior.
_Avoid_: MCP Resource Source, Workspace file, model tool

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

**Chat Platform Adapter**:
A ChatSDK adapter used by a message-shaped Channel for an external chat platform such as Teams.
_Avoid_: Agent Model Execution, Agent Trigger, Nitro handler

**Chat Adapter Package**:
An optional integration package that constructs a Chat Platform Adapter or conversation state backend, such as `@chat-adapter/teams` or `@chat-adapter/state-pg`.
_Avoid_: Built-in Capability, Agent Package dependency, generated adapter export

**Chat Adapter Facade**:
A narrow ViteHub-owned import subpath for a first-party-supported Chat Adapter Package when ViteHub owns a stable shim and missing-package diagnostics.
_Avoid_: Adapter barrel, generated upstream re-export, root Agent Package export

**Official Chat Adapter Support**:
ViteHub support for official Chat SDK platform adapters through concrete Channel Kinds, setup diagnostics, and webhook wiring while keeping the adapter package as an explicit application dependency.
_Avoid_: Bundled adapter dependency, generated adapter export, community adapter support by default

**Chat Adapter Callback**:
The lazy Channel option that returns the current request's Chat Platform Adapters.
_Avoid_: Webhook registration helper, adapter registry, build-time adapter scan

**Chat Platform Caller Facts**:
Trusted platform-scoped caller or source facts extracted from verified Chat Platform traffic before Agent Actor mapping.
_Avoid_: Auth User, Agent Actor, Access Role, chat identity, model-facing user profile

**Chat Webhook Autowiring**:
ViteHub-owned Channel wiring that exposes Chat Platform Adapter webhooks without app route code.
_Avoid_: Public registration function, local Teams route, manual webhook route

**Workspace Capability**:
A Capability that gives an Agent model-facing access to Workspace files.
_Avoid_: Bash, raw workspace tools, built-in tool

**Access Capability**:
A Capability created by `access()` that resolves trusted invocation access and applies allow-only access boundaries to configured runtime surfaces, starting with chat admission and Workspace Scope.
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

**Repository Host Capability**:
An Official Capability created by `repositoryHost()` for provider-hosted repository collaboration objects such as repository metadata, issues, Change Requests, Change Request file metadata, comments, and read-only check/status signals.
_Avoid_: gh, Git Capability, Source, Workspace Source, Forge Capability, SCM Capability

**Repository Host Provider**:
The configured repository hosting service behind a Repository Host Capability, such as GitHub, GitLab, Bitbucket, Forgejo, Gitea, Gerrit, SourceHut, or Azure DevOps.
_Avoid_: Git provider, SCM provider, platform

**Repository Host Client**:
The app-owned or runtime-provided adapter that executes normalized Repository Host Capability read and write requests against one Repository Host Provider.
_Avoid_: Provider SDK passthrough, raw API client, gh wrapper

**Change Request**:
A provider-hosted proposed repository change, called a pull request by GitHub and Bitbucket and a merge request by GitLab.
_Avoid_: PR as canonical term, MR as canonical term, change

**Pull Request Context Capability**:
A Capability for pull-request and review product events that contributes Agent Triggers, typed Agent Invocation Context Values, and lazy Workspace Sources for review material.
_Avoid_: prSummary, Repository Host Capability, markdown renderer, GitHub publication sink

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

**Git Capability**:
An official Capability that gives an Agent bounded Git source-history access and local Workspace Session git state selection.
_Avoid_: Workspace Shell Capability, unrestricted shell, remote publication

**Local Git State Change**:
A Workspace Session-local change to Git metadata, refs, index, or working tree used to inspect source history or select a local review state.
_Avoid_: Remote Git Publication, git history publication, git commit

**Remote Git Publication**:
A Git operation that creates, rewrites, deletes, or publishes commits, branches, tags, or remote refs outside the local Workspace Session.
_Avoid_: git write mode, fetch, local checkout

**MCP Capability**:
A Capability that connects an Agent to external MCP servers and exposes their model-facing tools.
_Avoid_: MCP server implementation, MCP Resource Source

**MCP Server**:
An external Model Context Protocol server consumed by an Agent through the MCP Capability.
_Avoid_: ViteHub-hosted server, Workspace Source

**Input Command**:
A Capability-provided command that accepts, rejects, transforms, or enriches explicit user input before an Agent runs.
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

**Rate Limit Capability**:
A Capability created by `rateLimit()` that checks or consumes a trusted invocation budget and may reject before the main Agent Invocation proceeds.
_Avoid_: App middleware, model-facing counter tool, KV wrapper

**Rate Limit Store**:
A runtime enforcement contract used by a Rate Limit Capability to check and consume invocation budgets.
_Avoid_: KV Store, hubKv, model-facing storage

## Relationships

- An Agent attaches zero or more **Capabilities**.
- Capabilities attach above the **Agent Driver** in the Agent Definition shape.
- Official helpers such as `skills()`, `transcribe()`, `mcp()`, `workspaceShell()`, `access()`, `sandbox()`, `kv()`, `blob()`, `db()`, `webSearch()`, `repositoryHost()`, `llmRoute()`, `llmGate()`, and `rateLimit()` create **Capability Definitions**.
- Official Capability factories and Capability-owned helper functions are imported from `@vite-hub/agent/capabilities`, not from the root `@vite-hub/agent` Agent Package entry.
- Channel Kind helpers are not Capability factories and are imported from `@vite-hub/agent/channels`.
- Official helpers should map to product abilities rather than implementation mechanisms.
- An official **Capability Definition** may carry a narrow **Capability Type Contract** when it directly consumes typed Agent Definition inputs such as Source keys, trusted Channel origins, or schema-validated invocation context.
- A **Capability Type Contract** checks developer configuration at Agent Definition time; it does not grant runtime authority or act as a generic invocation-context schema system.
- A **Capability Definition** may provide a **Capability Trigger Contribution** when the ability needs to start Agent Invocations from a product event.
- A **Capability Trigger Contribution** is composed from `defineAgent({ capabilities })`, not registered through a separate helper.
- A **Capability Trigger Contribution** belongs directly to the Capability shape unless a broader grouping earns its name later.
- A **Capability Trigger Contribution** maps product event input into Agent Invocation input and run metadata; Agent execution remains owned by the Agent Package.
- A **Capability Definition** may provide **Capability Driver Contributions** when the ability needs to feed the active Agent Driver.
- **Capability Driver Contributions** are conditional on the selected **Agent Driver**.
- A model-backed **Agent Driver** may receive model-facing tools from **Capability Driver Contributions**.
- Free-form Capability guidance for model-backed **Agent Drivers** should have **Capability Instruction Coverage** in Agent Driver Instructions or deterministic imported instruction Markdown.
- Tool descriptions and schemas are structured tool contracts and remain model-facing when the tool is exposed; they are not arbitrary Capability instructions.
- A model-backed **Agent Driver** may receive Instruction Composition context from **Capability Driver Contributions** by writing explicit **Agent Invocation Context Values** before instructions are rendered.
- A **Capability Definition** may provide a **Capability CLI Contribution** when the ability needs a real nested CLI surface for agents or developers.
- A **Capability CLI Contribution** is authored as a flat `cli` object on the **Capability Definition**, not through public command-builder helpers.
- First-party adapters may generate a **Capability CLI Contribution** internally from adapter metadata, but custom Capability authors still provide the flat `cli` object.
- A model-backed **Agent Driver** receives a controlled CLI-named tool with structured descriptions and schemas for a **Capability CLI Contribution**.
- The **Agent Dev Loop** may invoke a **Capability CLI Contribution** for the selected Agent without making a generic public JavaScript runner API.
- Legacy Capability instruction slots are unsupported; authored guidance belongs in Agent Driver Instructions with **Capability Instruction Coverage**.
- A harness-backed **Agent Driver** receives only explicitly supported harness-compatible **Capability Driver Contributions**; model-facing prompt and tool assumptions must not be silently passed into the harness.
- A **Harness Workspace Path Contribution** is an explicitly supported harness-compatible **Capability Driver Contribution**.
- A **Harness Workspace Path Contribution** is runtime support for the Capability, not a **Workspace Scope Grant** and not model-facing prompt text.
- A custom-run-backed **Agent Driver** receives prepared invocation context and Capability runtime effects; custom `run` code decides which Capability outputs to consume.
- A **Capability Definition** may provide **Capability Workspace Contributions** when trusted invocation context should add review, artifact, or other product-specific Workspace inputs before the Agent Driver sees Workspace surfaces.
- **Capability Workspace Contributions** are add-only and invocation-scoped; they fail on Source key, rule, Mount, and path conflicts instead of merging silently.
- A **Capability** may contribute **Agent Invocation Context Values** or Channel Delivery Effect Intents, but it does not execute Channel Delivery Effects or call platform-specific Channel APIs directly.
- Capabilities model reusable Agent abilities; app-owned product reachability belongs to **Channels** unless the product event has earned a reusable Capability name.
- The **Access Capability** may record selected Workspace Scope in invocation context, but it does not contribute free-form scope instructions.
- `skills()` may contribute **Skills** through **Harness Workspace Path Contributions** while suppressing model-facing skill instructions and tools for harness-backed **Agent Drivers**.
- Model-facing use guidance for a **Skill** should have **Skill Instruction Coverage**; the mounted Skill file can be read at runtime, but its presence alone should not clear instruction coverage warnings.
- A **Prompt Template** belongs to the Capability that renders it and should expose only the **Prompt Template Variables** that are stable for that Capability.
- An **MCP Prompt Template** is Capability behavior, not Workspace content by default.
- An **MCP Prompt Template** can be exposed as an **Input Command** when the host should let users invoke a named prompt before the Agent runs.
- If an **MCP Prompt Template** references read-only MCP resources, those resources can be exposed separately through an **MCP Resource Source**.
- Standard Schema validation is the preferred runtime boundary for app-owned invocation metadata that an official **Capability** directly consumes.
- An **Input Command** is a **Capability** concern resolved before model-facing Agent behavior.
- An **Input Command** owns command admission and input shaping, not model-facing task instructions.
- Command-shaped **Channel Delivery Admission** should preserve the explicit input and let configured **Input Commands** accept, reject, or reshape it before **Agent Driver** execution.
- A **Host Command** is not an **Input Command** and is outside the Capability Lifecycle.
- A **Pre-Invocation Decision** is an internal primitive used by Capabilities before the main Agent Invocation.
- A **Pre-Invocation Decision** can expose a typed invocation context value, reject the invocation, record an inspectable decision, or select Chat Session behavior.
- A **Pre-Invocation Decision** does not dynamically attach, remove, or grant **Capabilities**.
- Pre-Invocation Decision ids are unique per Agent; duplicate ids fail early instead of merging, prioritizing, or using last-write-wins behavior.
- An **LLM Route Capability** chooses one developer-defined option through an LLM and records the route decision. It does not apply route effects directly.
- An **LLM Gate Capability** chooses one developer-defined allow or reject category through an LLM and may reject before the main Agent Invocation.
- Deterministic or callback-based routing is not an official Capability in V1; users can define inline Capabilities or hooks that set named invocation context values.
- A **Rate Limit Capability** records a typed **Agent Invocation Context Value** with the checked or consumed budget result when an invocation is allowed or rejected.
- A **Rate Limit Capability** consumes trusted identity from the Agent Actor by default, including Agent Actor kind, or from stable Agent Run metadata, trusted IP headers, or a developer callback when explicitly configured.
- A **Rate Limit Capability** uses an explicit **Rate Limit Store** contract with non-consuming checks and consuming budget operations; model-facing storage Capabilities are not the runtime enforcement mechanism, and hosted runtimes require an explicit store choice.
- A **Rate Limit Store** owns persistence and coordination semantics for a Rate Limit Capability; model-facing storage tool surfaces do not become runtime enforcement APIs.
- A **Rate Limit Capability** consumes one budget unit per Agent Invocation in the first version; token, cost, or weighted usage budgets need a separate future design.
- Primitive storage helpers such as `kv()`, `blob()`, and `db()` are first-class official **Capabilities**, not sample raw-tool wrappers.
- Chat History and Chat Session behavior belong to message-shaped **Channels**, not a public Chat Capability.
- Shared message-shaped Channel behavior is configured through the Agent Definition's Message Channel Settings rather than a Capability.
- A message-shaped **Channel** may declare **Chat Platform Adapters** through a **Chat Adapter Callback**.
- A message-shaped **Channel** carries trusted origins from its Chat Platform Adapter names.
- A message-shaped **Channel** can provide a platform-scoped Agent Actor default for Chat Platform Adapter messages when trusted chat identity is available.
- A **Chat Platform Adapter** may come from a **Chat Adapter Package** that remains an explicit optional application dependency.
- The Agent Package should not generate exports for every **Chat Adapter Package**.
- A **Chat Adapter Facade** is reserved for first-party-supported adapters where ViteHub owns the public compatibility surface.
- **Official Chat Adapter Support** applies to official Vercel-maintained Chat SDK platform adapters; community and vendor adapters stay explicit **Custom Channel** or adapter-callback integrations until promoted.
- **Official Chat Adapter Support** means Channel support, diagnostics, and webhook wiring, not bundling or re-exporting every adapter factory.
- A message-shaped **Channel** can contribute trusted chat platform identity facts as the Agent Actor before later Capabilities resolve.
- **Chat Platform Adapters** are platform integration adapters, not **Agent Model Execution**.
- **Chat Webhook Autowiring** is inferred from the Agent's declared chat **Channel**; users do not attach a Capability or call a webhook registration helper for delivery wiring.
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
- An **Access Capability** can admit or reject normalized chat-origin invocations before the Agent Invocation starts.
- An **Access Capability** can apply **Workspace Scope** to narrow an already-declared Workspace.
- An **Access Capability** can record the active Workspace Scope as an Agent Invocation Context Value for later callbacks and instructions.
- An **Access Capability** owns both Workspace Scope selection and application, but keeps resolver logic separate from grants.
- An **Access Capability** may consume `context.actor` to select Workspace Scope without owning actor resolution; `context.invoker` remains a compatibility alias.
- An **Access Capability** may consume normalized chat identity and request context from a chat **Channel** without repeating Channel origins in Access configuration.
- An **Access Capability** can use static named Workspace Scopes or an inline Workspace Scope definition returned by its resolver.
- An **Access Capability** must be ordered before other Capabilities so invocation access is applied before they read scoped runtime surfaces or expose tools.
- An **Access Capability** provides tiny default **Access Roles** for the first version.
- The default `viewer` **Access Role** can read granted Source keys and path prefixes through Workspace Scope Grants.
- The default `admin` **Access Role** can select the explicit all-scopes mode when the developer configured that mode.
- A **Workspace Shell Capability** contributes shell-shaped Workspace tools without implying Sandbox execution.
- An **MCP Capability** consumes one or more external **MCP Servers**.
- An **MCP Capability** exposes executable MCP tools; read-only MCP resources belong to Source design.
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
- **Model Web Search Mode** is model-execution-gated; TanStack AI is not supported for model mode in the first version.
- A tool search provider and **Web Search Mode** are separate axes; provider is only used by tool-based **Web Search Mode**.
- The **Repository Host Capability** is for provider-hosted collaboration objects and externally visible collaboration effects, not raw git checkout/history, `gh` command execution, repository file Source retrieval, or arbitrary provider API passthrough.
- A **Repository Host Client** preserves provider-native ids, URLs, and raw metadata behind normalized Repository Host Capability requests.
- **Change Request** file-list reads are Repository Host reads; repository source diffs and git history still belong to Source, Workspace Source, or Git-aware capabilities.
- **Change Request** is the cross-provider term for pull-request and merge-request shaped objects; provider-native names stay in provider metadata.
- Repository Host Capability write mode starts with narrow comment and reaction effects; approval, merge, branch update, status/check write, issue edit, repository settings, content, secrets, workflow, and raw API mutations need separate future design.
- A **Pull Request Context Capability** owns trusted review intake, not model-facing repository collaboration tools or publication sinks.
- A **Pull Request Context Capability** can contribute Sources such as `pullRequest`, `pullRequestFiles`, `pullRequestReviews`, and `pullRequestChecks`, but those Sources remain Workspace inputs governed by Workspace Scope and Workspace Rules.
- A **Pull Request Context Capability** should keep full review material in lazy Live Sources or Request-Only Sources and keep only small trusted pull-request metadata in Agent Invocation Context Values.
- A **Pull Request Context Capability** can require explicit Workspace Rules for artifact writes such as `artifacts/review/**`, but it cannot grant new Capabilities or broaden Access-selected Workspace Scope.
- Chat History is not a standalone **Capability** in the current stack.
- Agent Memory is separate from Chat History and Chat Sessions.
- User-defined Capabilities use the same **Capability Definition** shape as official helpers.
- A **Capability Definition** can contribute tools, policy, metadata, Workspace inputs, and Agent Invocation Context Values.
- A **Capability Definition** uses `id` as its only capability-level identity and display label.
- Legacy `{{ capabilities }}` and `{{ capabilities.<id> }}` placement slots are unsupported.
- A configured **Capability** that is available to an Agent but lacks **Capability Instruction Coverage** should produce an Instruction Coverage Diagnostic.
- A configured **Skill** that is available to an Agent but lacks **Skill Instruction Coverage** should produce an Instruction Coverage Diagnostic.
- A **Capability** can declare **Capability Requirements**.
- The **Capability Lifecycle** validates **Capability Requirements** as early as possible.
- Tools are exposed through **Capability Definitions**, not through top-level Agent Definition fields.
- An **Input Command** exposes user-facing command descriptions for host rendering without making those descriptions model-facing instructions.
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
> **Domain expert:** "No. Keep **Access Role** for scope-selection authority; model-facing style can be normal prompt behavior that reads **Agent Actor** metadata."
>
> **Dev:** "Should Chat DevTools wire its own chat send helper?"
> **Domain expert:** "No. The message-shaped **Channel** should provide the trigger, and DevTools should consume the resolved Agent Trigger."
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
- Model-mode support for TanStack AI was considered - resolved: fail early for TanStack AI until ViteHub has a model-execution-native provider-tool contribution path.
- Model-controlled provider choice, automatic provider choice, and provider fan-out were considered - resolved: provider choice belongs to explicit **Web Search Provider Policy**, and the first version selects one provider only.
- Requiring the selected search provider to also own URL reading was considered - resolved: search provider policy and **Web Read Provider** are separate in the first version.
- Model-facing provider reachability was considered - resolved: keep provider reachability developer-facing in the first version.
- `VITE_*` and `NITRO_*` provider credential names were considered - resolved: reject them for **Web Search Credential Sources**; `VITE_*` is browser-exposed Vite language, and `NITRO_*` is framework runtime-config language rather than Capability credential language.
- Tool-first surfaces were considered the primary model - resolved: tools are one contribution of a **Capability Definition**.
- Chat-specific helpers were considered for server-side trigger behavior - resolved: message-shaped **Channels** own chat trigger behavior, while reusable abilities still use **Capability Trigger Contributions**.
- Grouping trigger contributions under a `server` bucket was considered - resolved: keep triggers directly capability-owned because Agent Triggers are server-authoritative by default and no broader server contribution group has been proven yet.
- Trigger handlers were considered for direct Agent execution - resolved: trigger contributions map input and run metadata, while the Agent Package executes the Agent Invocation through the standard lifecycle.
- Public chat webhook registration helpers were considered for platform adapters - resolved: use **Chat Webhook Autowiring** from the declared concrete **Channel Kind** so adapter configuration remains the only source of truth.
- Build-time Chat Platform Adapter detection was considered - resolved: resolve the **Chat Adapter Callback** at request time because platform credentials and adapter construction can depend on Server Env.
- Repeating Channel origins in `access()` was considered - resolved: the concrete **Channel Kind** owns adapter/webhook origin configuration, while **Access Capability** consumes normalized chat identity and request context for chat admission.
- A generic `entry()` Capability was considered for app-owned product events - resolved: use root-level **Custom Channels** so reachability stays on the Agent Definition rather than inside Capabilities.
- Capability phases, contexts, hooks, and instruction slots were considered glossary terms - resolved: group that detail under **Capability Lifecycle** unless a feature needs a sharper term.
- Capability tools and instructions were considered unconditional Agent inputs - resolved: use **Capability Driver Contribution** and filter driver-facing inputs by the selected Agent Driver.
- Generated Skill hints were considered enough model guidance - resolved: keep **Skills** as Workspace files behind `skills()` and require **Skill Instruction Coverage** for model-facing use guidance.
- Skill files for harness-backed Agent Drivers were considered part of the selected product **Workspace Scope** - resolved: use **Harness Workspace Path Contributions** so Capability support files can be materialized without broadening access-selected Workspace data.
- Bare Capability id instruction slots such as `mcp` were considered - resolved: do not support Capability instruction slots; use **Capability Instruction Coverage** instead.
- Chat History was considered as a standalone Capability - resolved: keep Chat History as message-shaped **Channel** conversation behavior for this stack and revisit during a future Agent Memory pass.
- Shared message defaults were considered as a Capability or Channel helper concern - resolved: use Agent Definition Message Channel Settings, while Capabilities consume the resulting invocation context.
- Agent Memory was considered dependent on chat behavior - resolved: stack Agent Memory directly on the capability runtime because memory and chat are separate concerns.
- Workspace inspection was considered a hand-written raw tool contribution or Bash concern - resolved: expose it through a **Workspace Capability**.
- Workspace Scope was considered as Workspace Definition mutation by a Capability - resolved: use an **Access Capability** to narrow an already-declared Workspace at invocation time instead of changing Sources or Workspace Rules.
- `workspaceScope()` was considered as the public helper name - resolved: use `access()` for the Capability while preserving **Workspace Scope** for the Workspace-specific boundary.
- `organization()` was considered as the public helper name - resolved: reject it because access decisions may come from organizations, customer domains, local config, or other trusted invocation context.
- Pre-registering every customer Workspace Scope was considered necessary - resolved: an Access Capability resolver may return an inline Workspace Scope definition for invocation-specific grants.
- Prompt audience was considered part of the **Access Capability** because it may use the same trusted identity facts - resolved: keep prompt instructions as normal Capability or Agent behavior that reads **Agent Actor** metadata when shared selection is needed.
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
- App-level rate-limit middleware was considered for agent chat entry points - resolved: use a **Rate Limit Capability** so invocation budgets compose through Agent Definitions and can run before model execution on every Agent Invocation path.
- Plain KV `get`/`set` counters were considered for **Rate Limit Capability** storage - resolved: rate limiting needs an explicit consume contract because distributed enforcement depends on atomic store behavior.
- Client-provided app-route user/run fields were considered for **Rate Limit Capability** defaults - resolved: do not trust them as budget identity; official chat triggers should produce an Agent Actor from trusted server-side inputs.
- Forwarded request headers were considered for default IP identity - resolved: require explicit trusted header names because proxy trust is deployment-specific.
- Exposing `hubKv` as a **Rate Limit Capability** option was considered - resolved: keep `store` as the Rate Limit Store boundary and let provider-specific KV handles live inside adapters or future helpers.
- Weighted rate-limit costs were considered for the first version - resolved: use one Agent Invocation as the budget unit and defer token, cost, and usage quotas until Agent Usage requirements prove the shape.
- Typed capability preparation was considered as a runtime lifecycle phase - resolved: use narrow **Capability Type Contracts** for type-only Agent Definition checks on official Capabilities, and keep runtime validation inside the **Capability Lifecycle**.
- A generic custom-Capability contract framework was considered - resolved: defer it until user-defined Capabilities prove a stable story; the current contract exists for official Capabilities that directly consume Agent Definition inputs.
- Input Command display metadata was considered capability-level - resolved: Capability id owns identity, while command descriptions are the user-facing metadata hosts may render.
- Requiring users to attach one Capability per internal mechanism was considered - resolved: users attach one Capability per product ability, and official Capabilities can own their natural Input Command surface when that command is part of the expected user experience.
- Storage Capability options were described as access levels in an older PR - resolved: official primitive Capabilities use `mode` for read/write exposure, while `access` is older proposal language.
- Storage helpers were considered examples around raw tools - resolved: KV, Blob, and DB helpers are first-class official **Capabilities**.
- Root Agent Package exports were considered convenient for official Capability factories - resolved: keep official Capability factories and their companion helpers on `@vite-hub/agent/capabilities` so the root entry stays focused on Agent Definition and invocation primitives.
- Reusing `@vite-hub/agent/capabilities` for Channel helpers was considered - resolved: official Channel Kind helpers live on `@vite-hub/agent/channels` so Channels and Capabilities stay distinct.
- Storage Capabilities were considered as direct primitive method proxies - resolved: official storage Capabilities should stay small with read/edit tools rather than method fanout.
- DB storage permission was considered one mode - resolved: DB separates data `mode` from **Schema Mode** because data reads/writes and schema inspection/changes are different authorities.
- Storage write mode was considered enough to allow immediate mutations - resolved: write exposure and approval policy are separate, so developers can opt into **Autonomous Storage Writes** explicitly.
- DB schema writes were considered for a separate edit tool - resolved: keep one DB edit tool and classify SQL statements against data `mode` and **Schema Mode**.
- DB tools were considered for read/edit naming to match KV and Blob - resolved: use `db_query` and `db_exec` because SQL agents and database tooling already use query/execute language.
- Primitive storage Capabilities were considered for direct runtime package imports - resolved: wrap configured primitive handles from the Capability context so primitive configuration remains outside the Agent Package.
- Agent-managed database changes were considered for multi-statement migration batches - resolved: v1 DB tools require one SQL statement per tool call and reject transaction-shaped SQL.

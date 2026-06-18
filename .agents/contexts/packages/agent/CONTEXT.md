# Agent Package

Agent Package names ownership boundaries for `@vite-hub/agent`.

## Language

**Agent Package**:
The package that owns Agent definitions, Agent invocations, and Agent capability composition.
_Avoid_: Chat package, runtime package

**Chat Package Migration**:
The move from standalone chat and messages packages into Agent Package ownership.
_Avoid_: Compatibility wrapper, separate chat package

**Chat Definition Removal**:
The removal of public chat Definition Boundary Helpers, chat framework modules, and chat definition discovery in favor of concrete Channel discovery through Agent Definitions.
_Avoid_: Chat definition migration, compatibility shim, chat module

**Chat Identity Removal**:
The removal of public Chat Capability caller configuration in favor of Agent Invoker resolution.
_Avoid_: Chat identity migration, adapter identity, compatibility alias

**Agent Route Owner**:
The Agent Package role that exposes discovered Agents over HTTP when routes are enabled.
_Avoid_: Nitro route package, adapter owner

**Agent File Name**:
The file or agent folder name used as the Discovery Identity for a discovered Agent Definition.
_Avoid_: `defineAgent({ name })`, display name

**Agent Model Execution Boundary**:
The Agent Package-owned boundary where model-backed Agent Drivers configure `execution` settings and instrumentation.
_Avoid_: Adapter options, provider package, model package

**Agent Driver Boundary**:
The Agent Package-owned Agent Definition boundary for selecting and configuring how Agent Invocations are driven, including model-backed and harness-backed drivers.
_Avoid_: Public adapter selector, top-level model selector, top-level harness selector, driver factory wrapper, root run callback

**Agent Harness Driver Contract**:
The Agent Package-owned contract implemented by harness-backed Agent Drivers, including invocation input, workspace access, lifecycle events, streams, approvals, and telemetry.
_Avoid_: AI SDK HarnessAgent as public API, raw harness adapter, provider-owned Agent Driver

**Harness Permission Policy**:
The Agent Package-owned policy for configuring harness adapter approval behavior for harness-backed Agent Drivers.
_Avoid_: Provider permission stack, hidden adapter approvals, two-layer approval policy

**Harness Credential Source**:
The resolved credential and billing identity source for a harness-backed Agent Driver, such as explicit driver credentials, adapter-default ambient auth, or a no-credentials-required harness.
_Avoid_: Required credential object, hidden cost owner, provider-specific env helper

**Agent Trigger API**:
The Agent Package public surface that composes Capability-owned Agent Trigger behavior from Agent Definitions.
_Avoid_: Chat adapter API, DevTools bridge API, client SDK

**Agent Trigger Consumer**:
The Agent Package implementation role that invokes a resolved Agent Trigger on behalf of a Channel, DevTools bridge, webhook, app route, or generated route.
_Avoid_: Channel, chat handler, trigger definition, capability config

**Chat Webhook Route**:
The Agent Package generated POST route that receives platform webhooks for chat-capable Agents.
_Avoid_: App route, Teams route, public registration helper

**Chat Webhook Handler**:
The Agent Package runtime handler behind the Chat Webhook Route that resolves the Agent's message-shaped Channel options, invokes the platform webhook, and starts the resolved chat Agent Trigger.
_Avoid_: User route handler, adapter registration API, Chat Capability definition

**Chat Platform Public Configuration**:
The Chat Capability public configuration surface that names external chat ingress by platform, such as Teams.
_Avoid_: Adapter map, Chat Invoker policy, webhook registration helper

**Chat Adapter Facade**:
A narrow Agent Package subpath for a first-party-supported Chat Platform Adapter or chat state backend when ViteHub owns a stable compatibility shim.
_Avoid_: Root Agent Package export, generated adapter barrel, upstream package mirror

**Channel Helper Entry**:
The Agent Package subpath that exports official Channel Kind helpers.
_Avoid_: Root Agent Package export, Capability factory export, Chat Adapter Facade

## Relationships

- The **Agent Package** owns Agent Definition shape.
- The **Agent Package** owns Agent invocation handling.
- The **Agent Package** owns the **Agent Driver Boundary**.
- The **Agent Package** owns the **Agent Harness Driver Contract** for harness-backed Agent Drivers.
- The **Agent Package** owns **Harness Permission Policy** for harness-backed Agent Drivers.
- V1 **Harness Permission Policy** bypasses adapter-level approval prompts by configuring the harness adapter to its most permissive no-approval mode when available.
- The **Agent Package** should not expose a public permission option in V1; bypass is implicit because it is the only supported **Harness Permission Policy**.
- For the current AI SDK Codex adapter, the **Agent Package** should set `permissionMode: "allow-all"` behind the ViteHub harness adapter boundary.
- The **Agent Package** should reject or mark unsupported a V1 harness adapter that cannot bypass its own approval layer.
- V1 harness-backed Agent Drivers should rely on ViteHub-owned Workspace and runtime boundaries instead of host-executed HarnessAgent approval flows.
- The **Agent Package** allows harness-backed Agent Drivers to omit `credentials`.
- When `credentials` are omitted, the **Agent Package** lets the harness adapter use its default credential behavior and classifies the resolved **Harness Credential Source** when possible.
- The **Agent Package** expects explicit Harness Credential Source configuration as a sibling harness-backed Agent Driver option rather than adapter-owned constructor state.
- The **Agent Package** consumes Env Package Server Env and Secret Env values for explicit deployable harness credential material rather than defining provider-specific env helper namespaces.
- The **Agent Package** should warn in development when omitted harness credentials resolve to an unknown or local-only Harness Credential Source.
- The **Agent Package** should fail hosted production when omitted harness credentials resolve to an unknown or known local-only Harness Credential Source.
- The **Agent Package** may allow hosted production to proceed when omitted harness credentials resolve to an adapter-classified deployable source or no-credentials-required harness.
- The **Agent Package** owns normalizing Agent Usage Records across Agent Driver variants.
- The **Agent Package** should allow harness-backed Agent Drivers to produce Agent Usage Records without token counts when the harness reports non-token usage details.
- The **Agent Package** should preserve raw provider- or harness-reported usage details and the resolved Harness Credential Source label when available without exposing secrets.
- The **Agent Package** coordinates scoped Workspace Session preparation for harness-backed Agent Drivers through the Workspace Package boundary.
- The **Agent Package** does not copy Flue-style root `tools`, `skills`, or `sandbox` fields; harness sandbox setup stays under `driver`, and tools or Skills stay Capability-owned.
- The **Agent Package** resolves explicit Harness Session Keys for harness-backed Agent Drivers and does not infer durable harness reuse from chat or thread metadata by default.
- An **Agent Driver Boundary** is configured as one object on the Agent Definition, with exactly one concrete driver key such as `model`, `harness`, or `run`.
- The concrete **Agent Driver Boundary** key holds the implementation value directly; driver-specific options are sibling fields on the same driver object.
- **Agent Driver Boundary** variants are mutually exclusive; the Agent Package should reject a driver object that combines `model`, `harness`, or `run`.
- The **Agent Package** owns filtering Capability Driver Contributions for the selected Agent Driver.
- The **Agent Package** owns composing visible Workspace Source Instructions into final model instructions for model-backed Agent Drivers.
- The **Agent Package** does not pass model-facing instructions to harness-backed Agent Drivers by default.
- The **Agent Package** owns the **Agent Trigger API** that resolves trigger contributions from Agent Capabilities.
- An **Agent Trigger Consumer** uses the **Agent Trigger API** and does not create a parallel chat-specific behavior surface.
- An **Agent Trigger Consumer** may pass a trusted Agent Invoker through trigger input when it has already authenticated or resolved caller identity; trigger metadata should not become a parallel identity boundary.
- A **Channel** may be implemented by an **Agent Trigger Consumer**, but Channel is the framework term for Agent reachability.
- Generated routes and DevTools use Channel identity when exposing channel-owned entry paths.
- The Agent Invocation Stream Endpoint is a V1 **Agent Trigger Consumer** for development clients.
- The Agent Invocation Stream Endpoint is installed by the Agent Package Vite Integration independently of DevTools.
- A **Chat Webhook Route** is an **Agent Trigger Consumer** generated by the Agent Package for discovered Agents with a message-shaped Channel.
- A **Chat Webhook Handler** consumes resolved message-shaped Channel options and platform adapters; it does not declare Chat Capability behavior itself.
- A **Chat Webhook Route** is automatic for discovered chat-capable Agents and does not require a public registration helper or app-owned route file.
- Generated **Chat Webhook Route** paths include the configured Channel ID so multiple Channels with the same Channel Kind do not collide.
- A public endpoint consumes an **Agent Trigger**; it does not own, declare, or attach the trigger.
- The **Agent Package** owns Agent capability composition.
- The root `@vite-hub/agent` entry exports Agent Definition, invocation, message, and generic composition primitives; official Capability factories live on `@vite-hub/agent/capabilities`.
- Official Channel Kind helpers live on `@vite-hub/agent/channels`.
- Channel object keys in Agent Definitions are configured Channel IDs; Channel helper names describe Channel Kinds.
- The root `@vite-hub/agent` entry exports Agent Invoker types as Agent Definition and Agent Invocation composition primitives.
- The root `@vite-hub/agent` entry does not export optional Chat Platform Adapter factories.
- The **Agent Package** may expose a **Chat Adapter Facade** only for a first-party-supported adapter with a stable shim and clear missing-package diagnostics.
- The **Agent Package** should not mirror every upstream `@chat-adapter/*` package as public ViteHub API.
- The **Agent Package** owns chat behavior after the **Chat Package Migration**.
- **Chat Definition Removal** means chat behavior is discovered through Agent Definitions that declare concrete message-shaped Channels, not through chat definitions, chat modules, or standalone chat discovery.
- A discovered Agent Definition that declares a message-shaped Channel is implicitly chat-capable for DevTools and Chat Webhook Route behavior.
- An **Agent File Name** provides Discovery Identity for discovered Agent Definitions.
- The **Agent Route Owner** is the Agent Package when generated Agent routes are enabled.
- The **Agent Driver Boundary** replaces top-level `model` and `harness` selectors.
- The **Agent Model Execution Boundary** replaces public adapter options inside model-backed Agent Drivers and is configured through `driver.execution`.
- AI SDK `HarnessAgent` support sits behind the **Agent Harness Driver Contract** and does not become the public Agent Package boundary.
- Shared runtime capabilities, approvals, and tracing belong to the Runtime Package.

## Example Dialogue

> **Dev:** "Should a model provider decide how ViteHub resolves workspace tools?"
> **Domain expert:** "No. That crosses the **Agent Model Execution Boundary**. The provider handles model calls; the **Agent Package** owns Agent runtime behavior."
>
> **Dev:** "Should Chat DevTools expose the reusable server-side send primitive?"
> **Domain expert:** "No. The **Agent Trigger API** belongs to the **Agent Package**; the message-shaped Channel contributes the trigger and Chat DevTools consumes it."

## Flagged Ambiguities

- Agent routes were considered generic Nitro routes - resolved: generated Agent routes belong to the **Agent Package**.
- Provider adapters were considered owners of runtime behavior - resolved: provider-specific behavior sits behind the **Agent Driver Boundary** and, for model-backed drivers, the **Agent Model Execution Boundary**.
- The public `adapter` option was considered necessary for future model-provider flexibility - resolved: use the **Agent Driver Boundary** instead of adapter-boundary language.
- Top-level `model` and `harness` selectors were considered part of Agent Definition shape - resolved: select model-backed or harness-backed execution through the **Agent Driver Boundary**.
- Driver factory wrappers such as `modelDriver()` and `harnessDriver()` were considered for explicitness - resolved: configure the **Agent Driver Boundary** as a single object variant and distinguish variants by exclusive keys.
- Nested driver implementation objects such as `driver: { model: { use } }` were considered - resolved: the driver variant key holds the implementation value directly, with variant options as sibling fields.
- Deterministic `run` callbacks were considered separate from the **Agent Driver Boundary** - resolved: `run` is the custom-run-backed Agent Driver variant and root `run` should migrate to `driver: { run }`.
- Combining model-backed execution with custom `run` was considered for fallback or post-processing - resolved: **Agent Driver Boundary** variants are mutually exclusive; custom code that wants to call a model belongs in `driver: { run }`.
- Root `modelExecution` was considered for preservation inside model-backed drivers - resolved: use `driver.execution` because `model` is already implied by the driver variant.
- Root Agent Definition `instructions` were considered shared by model-backed and harness-backed execution - resolved: model-facing instructions belong to the model-backed Agent Driver and are not passed to harness-backed drivers by default.
- Capability tools and instructions were considered unconditional Agent inputs - resolved: treat them as Capability Driver Contributions filtered by the selected Agent Driver.
- AI SDK `HarnessAgent` was considered as the public harness boundary - resolved: use the ViteHub-owned **Agent Harness Driver Contract** and adapt AI SDK harnesses behind it.
- Adapter-level harness approvals were considered for V1 - resolved: use Agent Package-owned **Harness Permission Policy** to bypass adapter approvals and rely on ViteHub-owned Workspace and runtime boundaries.
- A public permission option was considered for V1 - resolved: avoid it because bypass is the only supported **Harness Permission Policy** for now.
- A complete approval and permission matrix was considered for V1 - resolved: defer it; V1 rejects or marks unsupported harness adapters that cannot bypass their own approval layer.
- Model-facing Workspace Tools were considered the default Workspace surface for harness-backed drivers - resolved: harness-backed drivers use a scoped Workspace Session or equivalent materialized filesystem by default.
- Durable harness sessions were considered as an implicit chat or thread default - resolved: harness-backed Agent Drivers use invocation-scoped Harness Workspace Sessions by default and require an explicit Harness Session Key for reuse.
- Required harness credentials were considered - resolved: `credentials` is optional on harness-backed Agent Drivers, and omission means the harness adapter may use its default auth behavior.
- Development and hosted production credential diagnostics were considered equivalent - resolved: warn in development for unknown or local-only omitted credentials, but fail hosted production for unknown or known local-only omitted credentials.
- Adapter-owned harness credentials were considered - resolved: keep Harness Credential Source as a sibling harness-backed Agent Driver option so Agent Package validation, diagnostics, redaction, and usage labeling can run before the adapter.
- Provider-specific env helpers were considered for deployable harness credentials - resolved: keep environment declaration, resolution, and secret redaction in Env Package; Agent Package only labels, validates, and consumes the explicit credential source.
- Harness accounting was considered a separate Agent Package surface - resolved: use Agent Usage Records across Agent Driver variants, with non-token harness details preserved instead of forced into token counts.
- Public `adapterOptions` were considered the home for model execution settings - resolved: replace them with Agent-owned model execution settings inside model-backed Agent Drivers instead of preserving adapter-boundary language.
- Standalone chat and messages packages were considered compatibility boundaries - resolved: remove them during the **Chat Package Migration** rather than keeping wrappers.
- `defineChat`, `server/chat.ts`, `server/chats/*`, chat framework modules, and chat definition discovery were considered compatibility surfaces - resolved: delete them during **Chat Definition Removal** and expose chat only through concrete message-shaped Channels on discovered Agent Definitions.
- `defineAgent({ name })` was considered a discovered Agent identity override - resolved: use **Agent File Name** for discovered Agent identity.
- `server/agents/<name>/config.ts` was considered invalid under filename-derived identity - resolved: it remains valid because the agent folder name is the Discovery Identity and supports Colocated Workspace Definition behavior.
- Named exports from aggregate agent files were considered a discovered Agent identity source - resolved: remove aggregate named-export discovery immediately with no backwards compatibility.
- Agent Trigger behavior was considered a DevTools bridge concern - resolved: compose it through the **Agent Package** from Capability-owned trigger contributions, with DevTools consuming the resolved trigger surface.
- Requiring explicit chat discovery configuration after **Chat Definition Removal** was considered - resolved: discover Agent Definitions only, then infer chat exposure from their declared message-shaped Channels.
- Rebuilding DevTools as a chat-specific integration was considered - resolved: DevTools should consume Agent Triggers immediately, with chat as the first demonstrated trigger.
- Full multi-agent chat selection in DevTools was deferred during **Chat Definition Removal** - resolved: the first cleanup can support the first discovered Agent with a `chat.message` trigger to keep the new pattern small.
- App-owned Teams webhook files and public webhook registration helpers were considered for ChatSDK adapters - resolved: the Agent Package owns automatic **Chat Webhook Routes** that consume concrete Channel adapter configuration.
- Provider-only webhook route identity was considered - resolved: generated **Chat Webhook Routes** include configured Channel ID rather than only provider or Channel Kind.
- Treating Chat as an official Capability factory was considered for quickstart convenience - resolved: Chat is a Channel, not a Capability.
- Root-exporting Invocation Profile helpers was considered alongside Capability factories - resolved: replace that path with the root Agent Definition `invoker` option and `context.invoker`, so ViteHub maintains one trusted caller identity concept.
- A separate client chat route Capability was considered for app UIs - resolved: app UIs should own their HTTP route and consume the shared `chat.message` trigger directly when they need one.
- "Endpoint has an Agent Trigger" was used for route exposure - resolved: Capabilities contribute **Agent Triggers**, while public endpoints are **Agent Trigger Consumers**.
- "Nuxt UI adapter" was considered for application chat UIs - resolved: application chat UIs are app-owned trigger consumers, while Chat Platforms remain for external chat ingress.
- Public `chat({ adapters })` was considered for Chat Capability platform configuration - resolved: use **Chat Platform Public Configuration** instead so the public API does not make adapter implementation objects look like the caller identity boundary.
- Public `chat({ identity })` and `AgentChatIdentityResolver` were considered for chat caller identity - resolved: remove them through **Chat Identity Removal** and keep **Agent Invoker** as the single trusted caller identity policy.
- Public `chat.identity` invocation context was considered for convenience - resolved: remove it because callers should use `context.invoker` or Chat context values instead of a parallel identity string.
- `AccessChatIdentity` was considered for chat admission - resolved: Access should consume the resolved Agent Invoker plus chat/request facts rather than owning a separate chat identity shape.
- Source Instruction prompt rendering was considered Workspace Package ownership - resolved: Agent Package composes visible Source Instructions into model-backed driver instructions while Workspace Package exposes Source Instruction metadata.

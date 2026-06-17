# Agents

Agents names definitions, invocations, and runtime state for server actors driven by Agent Drivers.

## Language

**Agent**:
A named server-side actor that receives inputs, is driven by an Agent Driver, and may attach Capabilities.
_Avoid_: Bot, chat definition, workflow

**Agent Definition**:
The code declaration that names an Agent and configures its Channels, Workspace, Capabilities, Agent Invoker, and Agent Driver.
_Avoid_: Chat definition, server route

**Agent Driver**:
The Agent Definition boundary that selects and configures how an Agent Invocation is driven, such as a model-backed loop or harness-backed execution.
_Avoid_: Adapter, runtime, top-level model selector, top-level harness selector, driver factory wrapper, root run callback

**Model Driver Instructions**:
Model-facing instruction text or callbacks configured on a model-backed Agent Driver and composed before the model call.
_Avoid_: Root Agent Definition instructions, harness instructions, workspace `AGENTS.md`

**Agent Model Execution**:
The model-backed Agent Driver boundary for `execution` settings such as model call settings, step limits, workspace fallback behavior, and model execution instrumentation.
_Avoid_: Adapter options, provider options, passthrough

**Agent Harness Driver Contract**:
The ViteHub-owned contract implemented by harness-backed Agent Drivers, including how a harness receives invocation input, workspace access, lifecycle events, streams, approvals, and telemetry.
_Avoid_: AI SDK HarnessAgent as public boundary, raw harness adapter, provider-owned Agent Driver

**Harness Permission Policy**:
The ViteHub-owned policy for whether a harness-backed Agent Driver uses adapter-level approval prompts or bypasses them.
_Avoid_: Provider permission stack, hidden adapter approvals, two-layer approval policy

**Harness Credential Source**:
The resolved credential and billing identity source for a harness-backed Agent Driver, such as explicit driver credentials, adapter-default ambient auth, or a no-credentials-required harness.
_Avoid_: Required credential object, hidden cost owner, provider-specific env helper

**Agent Model Execution Instrumentation**:
Invocation-scoped hooks that wrap the resolved model or adjust model call settings before an Agent Invocation calls the model.
_Avoid_: Agent Invocation Lifecycle hooks, adapter middleware, provider wrapper

**Agent Invocation**:
One runtime request to an Agent.
_Avoid_: Chat message, webhook call

**Agent Trigger**:
The lower-level server-side primitive that maps a product event into an Agent Invocation.
_Avoid_: Channel, Chat adapter, client integration, model adapter

**Channel**:
A host or integration entry surface through which Agent Invocations are triggered, such as HTTP, Slack, Teams, Discord, CLI, DevTools, or web chat. It owns delivery coordination and caller mapping for that surface.
_Avoid_: Agent Invoker, Agent Trigger, Chat Platform Adapter, Auth User

**Channel ID**:
The stable id for one Channel declared on an Agent Definition.
_Avoid_: Agent name, Agent Invoker id, Agent Run Origin, thread id, platform id

**Channel Kind**:
The reusable Channel family named by what reaches the Agent, such as Slack, Teams, Discord, Web Chat, HTTP, CLI, or DevTools.
_Avoid_: Channel ID, Chat Channel, Chat Platform Adapter, product lane

**Custom Channel**:
A Channel declared for an app-owned product event or bespoke transport when no official Channel fits.
_Avoid_: Entry Capability, route helper, trigger helper, generic Capability

**Agent Invocation Lifecycle**:
The ordered runtime moments that occur while one Agent Invocation is processed.
_Avoid_: Capability Lifecycle, chat event hooks, request middleware

**Agent Finish Hook**:
The final Agent Invocation Lifecycle hook for observing the completed invocation outcome.
_Avoid_: onUsage, onRecord, afterRun

**Agent Invocation Extension**:
Capability-owned data attached to an Agent Invocation Lifecycle event without becoming a top-level lifecycle field.
_Avoid_: Event metadata, arbitrary event fields, built-in usage field

**Agent Eval**:
A repeatable development check that runs an Agent Definition against one or more cases and scores the resulting Agent Invocations.
_Avoid_: Benchmark, unit test, arena

**Agent Run State**:
Runtime state created while an Agent Invocation is being processed.
_Avoid_: Chat state, workflow state

**Agent Run Origin**:
Host-provided metadata naming where an Agent Invocation came from, such as `http`, `devtools`, or a Chat Platform name.
_Avoid_: Platform, Agent Trigger, runtime

**Agent Run Channel**:
Agent Run metadata that records the configured Channel ID and Channel Kind that triggered an Agent Invocation.
_Avoid_: Platform channel id, thread id, Agent Run Origin

**Agent Run Platform Context**:
Agent Run metadata for platform-native conversation and event identifiers, such as Slack channel ids, Teams conversation ids, Discord interaction ids, or Telegram chat ids.
_Avoid_: Channel ID, Agent Invoker, Agent Run Origin

**Chat History**:
Ordered conversational messages for one chat interaction with an Agent.
_Avoid_: Agent Memory, Agent Run State

**Chat History Window**:
The bounded number of prior Chat History messages included in an Agent Invocation.
_Avoid_: memory size, transcript limit, context length

**Chat Session**:
A host-visible conversation boundary inside Chat History that determines which messages are eligible for the Chat History Window.
_Avoid_: Agent Memory, Agent Run State, hidden slice

**Message Channel Settings**:
Agent Definition settings shared by message-shaped Channels, such as Chat History, Chat Session, and overlapping message delivery behavior.
_Avoid_: Channel defaults, runtime input messages, Agent Memory

**Agent Invoker**:
The trusted caller identity for one Agent Invocation, exposed as `context.invoker` with a stable `id`, optional `kind`, optional display `label`, and application-owned `meta`.
_Avoid_: Auth User, Agent Trigger, Access Role, Chat Platform Actor Facts, model-facing user profile

**Agent Invoker Profile**:
A static selectable Agent Invoker declared on an Agent Definition through `defineAgent({ invoker: { profiles } })`, mainly for development selection and trusted app routing.
_Avoid_: Invocation Profile, Access Role, dynamic profile Capability

**Agent Invocation Context Value**:
A typed value recorded for one Agent Invocation and exposed to later Agent and Capability callbacks through invocation context access.
_Avoid_: Runtime Config, Agent Memory, dynamic Capability, arbitrary metadata

**Agent Memory**:
Durable knowledge or preferences an Agent can carry across Agent Invocations when explicitly configured.
_Avoid_: Chat History, better chat state

**Concurrent Invocation Guard**:
Internal Agent behavior that prevents overlapping invocations from mutating the same Agent Run State.
_Avoid_: Public lock API, Capability

**Development State Provider**:
An in-memory or local provider used only for single-process Agent development.
_Avoid_: Production state provider, durable coordination

**Agent Usage**:
Normalized driver usage information produced by an Agent Invocation, including token counts when available and provider- or harness-reported usage details.
_Avoid_: Metadata, metrics

**Agent Usage Telemetry**:
Runtime measurement of an Agent Invocation's driver usage, latency, throughput, and cost context.
_Avoid_: Metadata, chat analytics, generic observability

**Agent Usage Record**:
The final completed accounting record captured after one Agent Invocation finishes, combining Agent Usage with selected Agent Driver, response, latency, and optional cost information.
_Avoid_: Live stream event, token log

**Mock Agent Adapter**:
A deterministic Agent Adapter that exercises Agent Invocation behavior without calling a paid model provider.
_Avoid_: Fake agent, dummy model, test bot

## Relationships

- An **Agent Definition** declares one **Agent**.
- An **Agent Definition** has one **Agent Driver**.
- An **Agent Driver** is configured as one object on the Agent Definition, with exactly one concrete driver key such as `model`, `harness`, or `run`.
- The concrete **Agent Driver** key holds the implementation value directly; driver-specific options are sibling fields on the same driver object.
- **Agent Driver** variants are mutually exclusive; one driver object cannot combine `model`, `harness`, or `run`.
- An **Agent Driver** may be model-backed, harness-backed, or custom-run-backed.
- A model-backed **Agent Driver** uses the AI SDK model execution path when it uses a model.
- A model-backed **Agent Driver** may configure **Model Driver Instructions**.
- A model-backed **Agent Driver** uses `execution` for **Agent Model Execution** settings.
- A harness-backed **Agent Driver** does not receive **Model Driver Instructions** as a system prompt by default.
- Harness-backed instruction behavior should rely on explicit harness or Workspace instruction surfaces, such as workspace `AGENTS.md`, unless a future harness-specific option is introduced.
- A harness-backed **Agent Driver** implements the **Agent Harness Driver Contract**.
- V1 harness-backed **Agent Drivers** use a single active permission layer: ViteHub-owned Workspace and runtime boundaries.
- V1 **Harness Permission Policy** bypasses adapter-level approval prompts by configuring the harness adapter to its most permissive no-approval mode when the adapter supports one.
- V1 does not expose a public permission option; bypass is implicit for supported harness-backed **Agent Drivers** until a second policy is intentionally designed.
- For the current AI SDK Codex adapter, V1 should use `permissionMode: "allow-all"` behind the ViteHub harness adapter boundary.
- A harness adapter that cannot bypass its own approval layer should be unsupported for V1 rather than introducing a second hidden permission layer.
- V1 should not enable host-executed HarnessAgent approval flows for harness-backed Agent Drivers; approval-based policy is a future design.
- A harness-backed **Agent Driver** receives Workspace state through a scoped **Workspace Session** or equivalent materialized filesystem, not model-facing Workspace Tools by default.
- A harness-backed **Agent Driver** uses an invocation-scoped Harness Workspace Session by default and requires an explicit Harness Session Key for durable reuse.
- A harness-backed **Agent Driver** may omit `credentials`; omitted credentials let the harness adapter use its default credential behavior, such as ambient CLI auth or no credentials when the harness does not require them.
- Explicit **Harness Credential Source** configuration is a sibling option on the harness-backed **Agent Driver**, not hidden inside the harness adapter constructor.
- Explicit deployable **Harness Credential Sources** should read secret material through Env Package **Server Env** and **Secret Env** instead of provider-specific env helper namespaces.
- A harness-backed **Agent Driver** should classify the resolved **Harness Credential Source** for diagnostics and telemetry when the adapter can report it.
- Development diagnostics should warn when omitted harness credentials resolve to an unknown or local-only **Harness Credential Source**.
- Hosted production should fail when omitted harness credentials resolve to an unknown or known local-only **Harness Credential Source**.
- Hosted production may proceed when omitted harness credentials resolve to an adapter-classified deployable source or a no-credentials-required harness.
- AI SDK `HarnessAgent` support is an implementation adapter behind the **Agent Harness Driver Contract**, not the public ViteHub Agent Driver boundary.
- A custom-run-backed **Agent Driver** invokes developer code directly through `run`.
- A custom-run-backed **Agent Driver** may call a model or harness internally, but ViteHub treats the public Agent Driver as custom-run-backed unless a future explicit composition primitive says otherwise.
- **Agent Model Execution** belongs to a model-backed Agent Driver and is not an adapter boundary.
- **Agent Model Execution Instrumentation** is lower-level Agent execution behavior and should not become root Agent Definition fields.
- **Agent Driver** is not a Capability, Agent Trigger, Chat Platform Adapter, or host runtime.
- Workspace plus Capability composition without an **Agent Driver** is not an **Agent Definition**.
- Capabilities attach above the **Agent Driver** and may expose driver-specific **Capability Driver Contributions**.
- An **Agent** receives zero or more **Agent Invocations**.
- An **Agent Trigger** starts one or more **Agent Invocations** as the lower-level invocation primitive behind Channels and Capability-owned product events.
- An **Agent Trigger** prepares **Agent Run State** and **Chat History** when the product event needs them.
- An **Agent Trigger** may provide message-shaped input, but message-shaped input is not required for every Agent Trigger.
- An **Agent Trigger** may pass host or client intent with the Agent Invocation, but it does not grant Capabilities dynamically.
- An **Agent Trigger** is registered by a Capability when the trigger belongs to a Capability-owned product ability.
- An **Agent Trigger** is not **Agent Model Execution**.
- An **Agent Trigger** is not a **Chat Platform Adapter**; Chat Platform Adapters receive platform events, while Agent Triggers start Agent Invocations.
- An **Agent Definition** declares the **Channels** through which its **Agent Invocations** can be triggered.
- **Channel IDs** are unique within one **Agent Definition** and stable enough for generated routes, DevTools, Agent Run metadata, admission, rate limits, and identity mapping.
- A **Channel ID** names one configured Channel; a **Channel Kind** names what kind of entry path reaches the Agent.
- In `defineAgent({ channels })`, object keys are **Channel IDs** and helper functions identify **Channel Kinds**.
- `defineAgent({ messages })` configures **Message Channel Settings** shared by message-shaped Channels; it does not declare runtime invocation messages.
- Per-Channel message-shaped overrides live under that Channel's own `messages` option.
- **Message Channel Settings** do not configure identity mapping; each concrete **Channel** maps trusted caller data into an **Agent Invoker**.
- **Message Channel Settings** may configure a default overlapping-message concurrency policy; platform rate limits, webhook retries, and provider delivery quotas stay on concrete **Channels**.
- A **Channel** is where an **Agent Invocation** is triggered; an **Agent Invoker** is who is trusted for that invocation.
- A **Channel** may use an **Agent Trigger** to start an **Agent Invocation**, but it is not the trigger itself.
- A **Channel** owns adapter and webhook wiring, delivery policies such as locks, dedupe, and concurrency, platform state, and platform identity mapping.
- A **Custom Channel** is the root Agent Definition replacement for the old Entry Capability idea.
- App-owned product events use **Custom Channels** when the concern is Agent reachability rather than a reusable Agent ability.
- Official **Channel Kinds** should name concrete entry paths rather than a generic Chat Channel.
- Official **Channel Kind** helpers are imported from `@vite-hub/agent/channels`, not from the Agent Package root or Capabilities entry.
- Message-shaped **Channel Kinds** keep the existing chat delivery behavior, including Chat Platform Adapters, webhook wiring, locks, dedupe, concurrency, platform state, and identity mapping.
- An **Agent Invocation** follows one **Agent Invocation Lifecycle**.
- An **Agent Finish Hook** belongs to the **Agent Invocation Lifecycle**.
- Capabilities can expose **Agent Invocation Extensions** on Agent Invocation Lifecycle events.
- An **Agent Eval** runs an **Agent Definition** to create scored **Agent Invocations**.
- An **Agent** can attach zero or more Capabilities.
- Tools are contributed by Capabilities, not by top-level Agent Definition fields.
- Model-facing tools and instructions are **Capability Driver Contributions** consumed only by compatible Agent Drivers.
- Workspace Tools are derived from an Agent's Colocated Workspace Definition.
- An **Agent Invocation** can create or update **Agent Run State**.
- An **Agent Run Origin** is observability metadata for an **Agent Invocation**; it is not the **Agent Trigger** that prepared the invocation.
- **Chat History** is conversation-scoped and is not **Agent Memory**.
- A **Chat Session** is part of Chat History behavior and is not **Agent Memory**.
- Message-shaped **Channels** resolve the active **Chat Session** before applying the **Chat History Window**.
- A **Chat History Window** is configured by the Agent Definition when the application wants bounded Chat History.
- Message-shaped **Channels** can require state for **Chat History** through the Agent State Provider.
- Every **Agent Invocation** has an **Agent Invoker**; when no trusted identity is supplied, ViteHub provides an origin-specific anonymous fallback.
- Message-shaped **Channels** can produce an **Agent Invoker** from trusted Chat Platform Adapter identity before later Capabilities resolve.
- **Agent Invoker** is available through `context.invoker` and as the `invoker` Agent Invocation Context Value; it is not model-facing by default.
- **Agent Invoker** resolution may read **Agent Run Origin** from first-class run metadata, but concrete authorization effects should flow through the resolved **Agent Invoker** rather than branching on origin later.
- **Agent Invoker Profiles** are static objects in the first version.
- **Agent Invoker Profile** ids must be unique per Agent Definition.
- DevTools can select configured **Agent Invoker Profiles** before a new Chat Session starts, but does not switch invokers in the middle of one conversation.
- Chat History is explicit application behavior and is not enabled by default.
- **Agent Invocation Context Values** can be produced by Pre-Invocation Decisions and read by later Agent or Capability callbacks.
- **Agent Invocation Context Values** do not grant Capabilities dynamically.
- **Agent Invocation Context Value** ids must be unique per Agent so every invocation has one writer per context value.
- **Agent Memory** can outlive one conversation.
- A **Concurrent Invocation Guard** protects **Agent Run State**.
- A **Development State Provider** is not acceptable for hosted production runtimes.
- **Agent Usage** belongs to one **Agent Invocation**.
- **Agent Usage Records** are the shared accounting surface for model-backed, harness-backed, and custom-run-backed Agent Drivers when they report usage.
- A model-backed **Agent Driver** may report token-shaped **Agent Usage**.
- A harness-backed **Agent Driver** should emit **Agent Usage Records** even when the provider reports sessions, actions, wall time, quota events, or other non-token usage units.
- **Agent Usage** token fields are present only when a provider reports or ViteHub can safely derive token counts.
- Non-token harness usage should be preserved as provider- or harness-reported raw usage details instead of translated into invented token counts.
- **Agent Usage Records** may include the resolved **Harness Credential Source** label or billing identity metadata when available without exposing the underlying secret.
- **Agent Usage Records** record cost only when a provider reports it or explicit pricing logic estimates it; ViteHub must not invent exact cost for subscription-backed harness runs.
- **Agent Usage Telemetry** observes **Agent Usage Records**.
- **Agent Usage Telemetry** can expose an **Agent Usage Record** as an **Agent Invocation Extension**.
- A **Mock Agent Adapter** can support playgrounds and end-to-end tests without creating provider cost.
- Agent callbacks receive Agent-owned runtime metadata, not app-owned Runtime Env; server code reads app-owned Runtime Env through Server Env.

## Example Dialogue

> **Dev:** "Should users configure `tools` directly on the Agent Definition?"
> **Domain expert:** "No. Tools belong inside Capability definitions so validation, policy, and DevTools metadata stay attached to the Capability."
>
> **Dev:** "Should the playground call a real model provider just to test DevTools?"
> **Domain expert:** "No. Use a **Mock Agent Adapter** when the goal is deterministic Agent behavior without token cost."
>
> **Dev:** "Should Chat DevTools own the server behavior for sending messages to an Agent?"
> **Domain expert:** "No. Chat DevTools should consume an **Agent Trigger** primitive, just like an application server route or webhook would."
>
> **Dev:** "Should an instruction callback read a routing decision from arbitrary metadata?"
> **Domain expert:** "No. Read it as an **Agent Invocation Context Value** produced by a Pre-Invocation Decision."
>
> **Dev:** "Should we put customer, staff, and technical-user branching into both `access()` and prompt instructions?"
> **Domain expert:** "Keep the shared facts on the **Agent Invoker**. Let `access()` map `context.invoker` to Workspace Scope, and let any prompt Capability or instruction callback read the same invoker metadata for model-facing text."
>
> **Dev:** "Is a new Chat Session the same as Agent Memory reset?"
> **Domain expert:** "No. A **Chat Session** changes which Chat History messages enter the Chat History Window; **Agent Memory** is durable knowledge across invocations."

## Flagged Ambiguities

- Raw tools were considered as top-level Agent Definition fields - resolved: tools are contributed by Capabilities.
- Flue-style root `tools`, `skills`, and `sandbox` fields were considered for harness-backed Agents - resolved: keep `sandbox` under the harness-backed **Agent Driver**, and keep tools or Skills behind Capabilities.
- Multi-adapter support was considered part of Agent Definition shape - resolved: use one **Agent Driver** boundary rather than public adapter selectors.
- Top-level `model` and `harness` selectors were considered part of Agent Definition shape - resolved: select model-backed or harness-backed execution through **Agent Driver**.
- Driver factory wrappers such as `modelDriver()` and `harnessDriver()` were considered for explicitness - resolved: configure the **Agent Driver** as a single object variant and distinguish variants by exclusive keys.
- Nested driver implementation objects such as `driver: { model: { use } }` were considered - resolved: the driver variant key holds the implementation value directly, with variant options as sibling fields.
- Deterministic `run` callbacks were considered separate from **Agent Driver** - resolved: `run` is the custom-run-backed Agent Driver variant and root `run` should migrate to `driver: { run }`.
- Combining model-backed execution with custom `run` was considered for fallback or post-processing - resolved: **Agent Driver** variants are mutually exclusive; custom code that wants to call a model belongs in `driver: { run }`.
- Root `modelExecution` was considered for preservation inside model-backed drivers - resolved: the model-backed Agent Driver uses `execution` because `model` is already implied by the driver variant.
- Root Agent Definition `instructions` were considered shared by model-backed and harness-backed execution - resolved: use **Model Driver Instructions** for model-backed drivers, and do not pass them to harness-backed drivers by default.
- AI SDK `HarnessAgent` was considered as the public harness boundary - resolved: use the ViteHub-owned **Agent Harness Driver Contract** and adapt AI SDK harnesses behind it.
- Adapter-level harness approvals were considered for V1 - resolved: use **Harness Permission Policy** to bypass adapter approvals and rely on ViteHub-owned Workspace and runtime boundaries, avoiding two active permission layers.
- A public permission option was considered for V1 - resolved: avoid it because bypass is the only supported **Harness Permission Policy** for now.
- A full approval policy matrix was considered for V1 - resolved: defer it; if a harness adapter cannot bypass its own approval layer, mark it unsupported for V1.
- Model-facing Workspace Tools were considered the default Workspace surface for harness-backed drivers - resolved: harness-backed drivers use a scoped **Workspace Session** or equivalent materialized filesystem by default.
- Durable harness sessions were considered as an implicit chat or thread default - resolved: harness-backed Agent Drivers use invocation-scoped Harness Workspace Sessions by default and require an explicit Harness Session Key for reuse.
- Requiring a `credentials` option for every harness-backed Agent Driver was considered - resolved: credentials are optional; omission means the harness adapter may use its default auth behavior, and ViteHub classifies the resolved **Harness Credential Source** when possible.
- Treating omitted harness credentials the same in development and hosted production was considered - resolved: warn in development for unknown or local-only sources, but fail hosted production for unknown or known local-only sources.
- Hiding credential configuration inside harness adapter constructors such as `codex()` was considered - resolved: configure **Harness Credential Source** as a sibling harness-backed Agent Driver option so ViteHub can validate, redact, and report it before adapter execution.
- Provider-specific env helper namespaces were considered for harness credentials - resolved: use Env Package **Server Env** and **Secret Env** for deployable secret material, and keep harness credential options focused on driver auth metadata.
- Harness usage accounting was considered a separate telemetry concept from model usage - resolved: use **Agent Usage Records** for every Agent Driver that reports usage, preserve non-token harness details, and do not invent exact subscription cost.
- Adapter-owned options were considered the home for model execution settings - resolved: use **Agent Model Execution** inside the model-backed Agent Driver and do not reintroduce public adapter-boundary language.
- Evalite-backed checks were considered generic tests - resolved: use **Agent Eval** when the check runs an Agent Definition and scores Agent Invocation output.
- Chat runtime state was considered a public Chat option - resolved: use **Agent Run State** for Agent-owned runtime state.
- Chat History and Agent Memory were considered interchangeable - resolved: Chat History is conversation-scoped message history; Agent Memory is durable knowledge or preferences across invocations.
- Chat Sessions were considered as Agent Memory or separate Chat Session Capabilities - resolved: **Chat Session** is Chat History behavior used by message-shaped **Channels**.
- `channelDefaults.message` and `channels.messages` were considered for shared message behavior - resolved: use root **Message Channel Settings** through `defineAgent({ messages })` and keep `channels` as the direct **Channel ID** map.
- Flat per-Channel message overrides were considered - resolved: nest them under the Channel's own `messages` option so route, adapter, identity, and message behavior do not collapse into one option bag.
- Identity mapping was considered for **Message Channel Settings** - resolved: keep it on concrete **Channels** because each Channel trusts different actor data.
- Root `messages.concurrency` was considered too platform-specific - resolved: allow it for overlapping message turns, while platform delivery limits stay Channel-specific.
- Hidden model-selected history slicing was considered - resolved: **Chat Session** selection is a host-visible boundary over preserved Chat History, not destructive message truncation.
- Route and gate results were considered for ad hoc input context or metadata - resolved: expose them as typed **Agent Invocation Context Values**.
- Shared access-and-audience branching was considered for reusable Invocation Profiles - resolved: use **Agent Invoker** as the root Agent Definition concept, with static **Agent Invoker Profiles** and app-owned `invoker.meta` for V1.
- Chat state was considered separate from Agent State Provider - resolved: Chat History state is satisfied through the Agent State Provider when available.
- Chat actor identity was considered a chat-history-only detail - resolved: expose it as an **Agent Invoker** so other Capabilities can consume it.
- Chat History was considered an implicit chat default - resolved: keep Chat History opt-in, aligned with Chat SDK-style application control.
- Local and hosted state providers were considered equivalent - resolved: hosted production runtimes require a durable provider and a **Concurrent Invocation Guard**.
- Model-free playground behavior was described as a dummy Agent - resolved: use **Mock Agent Adapter** for deterministic, cost-free Agent Invocations.
- Callback runtime config was considered an Agent app configuration surface - resolved: app-owned Runtime Env belongs to Server Env, not Agent callback context.
- Server-side chat integration was described as a chat adapter or client integration - resolved: use **Agent Trigger** for server-side behavior that starts Agent Invocations.
- ChatSDK adapters were considered Agent Triggers - resolved: a Chat Platform Adapter receives platform webhook events, and generated Chat Webhook wiring bridges those events into the concrete message-shaped **Channel**.
- Agent run metadata used `platform` for both chat adapters and generic invocation sources - resolved: use **Agent Run Origin** for run metadata and reserve platform language for **Chat Platform Adapters**.
- `run.channelId` was considered for both configured Channel IDs and platform conversation ids - resolved: use **Agent Run Channel** for configured ViteHub Channel identity and **Agent Run Platform Context** for platform-native ids.
- Agent Triggers were considered chat-only because chat is the first major use case - resolved: message-shaped **Channels** can provide official triggers, but Agent Triggers remain general and do not require message-shaped input.
- Chat helper APIs were considered the primary exposure path - resolved: Channel-owned trigger registration is the primary server-side path, with helpers only as optional callers or ergonomics around registered triggers.
- Client-provided flags were considered Capability configuration - resolved: triggers may pass host or client intent with the Agent Invocation, while Capabilities remain server-configured Agent behavior and the exact input field name is not fixed yet.

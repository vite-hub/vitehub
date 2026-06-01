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

**Agent Trigger**:
Server-side host or integration behavior that starts an Agent Invocation for a specific product event.
_Avoid_: Chat adapter, client integration, model adapter

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
Host-provided metadata naming where an Agent Invocation came from, such as `http`, `devtools`, or a Chat Platform Adapter name.
_Avoid_: Platform, Agent Trigger, runtime

**Chat History**:
Ordered conversational messages for one chat interaction with an Agent.
_Avoid_: Agent Memory, Agent Run State

**Chat History Window**:
The bounded number of prior Chat History messages included in an Agent Invocation.
_Avoid_: memory size, transcript limit, context length

**Chat Session**:
A host-visible conversation boundary inside Chat History that determines which messages are eligible for the Chat History Window.
_Avoid_: Agent Memory, Agent Run State, hidden slice

**Chat Identity**:
A trusted Agent Invocation Context Value produced by the Chat Capability that identifies the external chat actor for the current Agent Invocation.
_Avoid_: Chat History identity, Agent Memory, model-facing user profile

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
Normalized model usage information produced by an Agent Invocation, including token counts and provider-reported usage details.
_Avoid_: Metadata, metrics

**Agent Usage Telemetry**:
Runtime measurement of an Agent Invocation's model usage, latency, throughput, and cost.
_Avoid_: Metadata, chat analytics, generic observability

**Agent Usage Record**:
The final completed accounting record captured after one Agent Invocation finishes, combining Agent Usage with model, response, latency, and optional cost information.
_Avoid_: Live stream event, token log

**Mock Agent Adapter**:
A deterministic Agent Adapter that exercises Agent Invocation behavior without calling a paid model provider.
_Avoid_: Fake agent, dummy model, test bot

## Relationships

- An **Agent Definition** declares one **Agent**.
- An **Agent Definition** uses the AI SDK model execution path when it uses a model.
- **Agent Adapter Options** are legacy multi-adapter language and should be removed with the adapter selector.
- An **Agent** receives zero or more **Agent Invocations**.
- An **Agent Trigger** starts one or more **Agent Invocations**.
- An **Agent Trigger** prepares **Agent Run State** and **Chat History** when the product event needs them.
- An **Agent Trigger** may provide message-shaped input, but message-shaped input is not required for every Agent Trigger.
- An **Agent Trigger** may pass host or client intent with the Agent Invocation, but it does not grant Capabilities dynamically.
- An **Agent Trigger** is registered by a Capability when the trigger belongs to a Capability-owned product ability.
- An **Agent Trigger** is not an **Agent Model Adapter**.
- An **Agent Trigger** is not a **Chat Platform Adapter**; Chat Platform Adapters receive platform events, while Agent Triggers start Agent Invocations.
- An **Agent Invocation** follows one **Agent Invocation Lifecycle**.
- An **Agent Finish Hook** belongs to the **Agent Invocation Lifecycle**.
- Capabilities can expose **Agent Invocation Extensions** on Agent Invocation Lifecycle events.
- An **Agent Eval** runs an **Agent Definition** to create scored **Agent Invocations**.
- An **Agent** can attach zero or more Capabilities.
- Tools are contributed by Capabilities, not by top-level Agent Definition fields.
- Workspace Tools are derived from an Agent's Colocated Workspace Definition.
- An **Agent Invocation** can create or update **Agent Run State**.
- An **Agent Run Origin** is observability metadata for an **Agent Invocation**; it is not the **Agent Trigger** that prepared the invocation.
- **Chat History** is conversation-scoped and is not **Agent Memory**.
- A **Chat Session** is part of Chat History behavior and is not **Agent Memory**.
- The Chat Capability resolves the active **Chat Session** before applying the **Chat History Window**.
- A **Chat History Window** is configured by the Agent Definition when the application wants bounded Chat History.
- The Chat Capability can require state for **Chat History** through the Agent State Provider.
- The Chat Capability can produce **Chat Identity** before later Capabilities resolve.
- The default **Chat Identity** for Chat Platform Adapter messages is platform-scoped as `adapter:userId`; applications can override it when they own a stronger cross-platform identity.
- **Chat Identity** is available through Agent Invocation Context Values and is not model-facing by default.
- Chat History is explicit application behavior and is not enabled by default.
- **Agent Invocation Context Values** can be produced by Pre-Invocation Decisions and read by later Agent or Capability callbacks.
- **Agent Invocation Context Values** do not grant Capabilities dynamically.
- **Agent Invocation Context Value** ids must be unique per Agent so every invocation has one writer per context value.
- **Agent Memory** can outlive one conversation.
- A **Concurrent Invocation Guard** protects **Agent Run State**.
- A **Development State Provider** is not acceptable for hosted production runtimes.
- **Agent Usage** belongs to one **Agent Invocation**.
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
> **Dev:** "Is a new Chat Session the same as Agent Memory reset?"
> **Domain expert:** "No. A **Chat Session** changes which Chat History messages enter the Chat History Window; **Agent Memory** is durable knowledge across invocations."

## Flagged Ambiguities

- Raw tools were considered as top-level Agent Definition fields - resolved: tools are contributed by Capabilities.
- Multi-adapter support was considered part of Agent Definition shape - resolved: remove the adapter selector and make AI SDK the only model execution path for now.
- Evalite-backed checks were considered generic tests - resolved: use **Agent Eval** when the check runs an Agent Definition and scores Agent Invocation output.
- Chat runtime state was considered a public Chat option - resolved: use **Agent Run State** for Agent-owned runtime state.
- Chat History and Agent Memory were considered interchangeable - resolved: Chat History is conversation-scoped message history; Agent Memory is durable knowledge or preferences across invocations.
- Chat Sessions were considered as Agent Memory or separate Chat Session Capabilities - resolved: **Chat Session** is Chat History behavior owned by the Chat Capability.
- Hidden model-selected history slicing was considered - resolved: **Chat Session** selection is a host-visible boundary over preserved Chat History, not destructive message truncation.
- Route and gate results were considered for ad hoc input context or metadata - resolved: expose them as typed **Agent Invocation Context Values**.
- Chat state was considered separate from Agent State Provider - resolved: Chat History state is satisfied through the Agent State Provider when available.
- Chat actor identity was considered a chat-history-only detail - resolved: expose **Chat Identity** as a trusted Agent Invocation Context Value so other Capabilities can consume it.
- Chat History was considered an implicit Chat Capability default - resolved: keep Chat History opt-in, aligned with Chat SDK-style application control.
- Local and hosted state providers were considered equivalent - resolved: hosted production runtimes require a durable provider and a **Concurrent Invocation Guard**.
- Model-free playground behavior was described as a dummy Agent - resolved: use **Mock Agent Adapter** for deterministic, cost-free Agent Invocations.
- Callback runtime config was considered an Agent app configuration surface - resolved: app-owned Runtime Env belongs to Server Env, not Agent callback context.
- Server-side chat integration was described as a chat adapter or client integration - resolved: use **Agent Trigger** for server-side behavior that starts Agent Invocations.
- ChatSDK adapters were considered Agent Triggers - resolved: a Chat Platform Adapter receives platform webhook events, and generated Chat Webhook wiring bridges those events into the Chat Capability's Agent Trigger.
- Agent run metadata used `platform` for both chat adapters and generic invocation sources - resolved: use **Agent Run Origin** for run metadata and reserve platform language for **Chat Platform Adapters**.
- Agent Triggers were considered chat-only because chat is the first major use case - resolved: Chat can provide the first official Capability-owned trigger, but Agent Triggers remain general and do not require message-shaped input.
- Chat helper APIs were considered the primary exposure path - resolved: Capability-owned trigger registration is the primary server-side path, with helpers only as optional callers or ergonomics around registered triggers.
- Client-provided flags were considered Capability configuration - resolved: triggers may pass host or client intent with the Agent Invocation, while Capabilities remain server-configured Agent behavior and the exact input field name is not fixed yet.

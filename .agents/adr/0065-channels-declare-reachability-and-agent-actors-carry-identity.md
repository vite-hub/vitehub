# Channels Declare Reachability And Agent Actors Carry Identity

## Status

Accepted.

## Context

ViteHub split chat-owned behavior into Channels and Capabilities, while Chat SDK adapter support and Quiver Review webhook work exposed that external entry surfaces need one declaration model. Earlier ADRs made Agent Invoker the identity boundary, but the new Channels design needs reachability and trusted principal identity to stay separate.

## Decision

ViteHub will add a declaration-first Channels API under `defineAgent({ channels })`. Custom Channels use `defineChannel()`, and official Channel Kind helpers such as GitHub, Slack, Teams, Telegram, Stream, CLI, DevTools, HTTP, and Web Chat are thin wrappers over the same Channel Definition shape. Channels may register Agent Trigger behavior through one generic trigger contract; message-shaped Channels layer Message Channel Settings on top instead of owning a separate trigger DSL. Protocol-level acceptance is Channel Delivery Admission. User-visible platform feedback after accepted delivery is a Channel Delivery Effect. Both belong to Channel delivery behavior rather than Capability hooks or Agent result comments. Capabilities and Channel Triggers may contribute platform-neutral Channel Delivery Effect Intents for the current delivery, including finish-time intents derived from the completed Agent Invocation, while the active Channel owns execution, platform mapping, and unsupported-effect handling. ViteHub may share hook machinery and conventions across Agents, Channels, Capabilities, Runtime, and integrations, but public mutation hooks stay owner-scoped; cross-owner observers are read-only and cannot affect Agent Invocation control flow.

Identity is **Agent Actor**, not Channel Actor. A Channel can resolve an Agent Actor from trusted delivery data, but Auth bridges, trusted app routes, subagents, schedules, or fallback runtime behavior may also seed the Actor. `context.actor` is the public callback identity shape; legacy `context.invoker`, `defineAgent({ invoker })`, and Agent Invoker Profiles remain compatibility surfaces while the configuration API migrates.

## Considered Options

- Keeping Agent Invoker as the durable public noun was rejected because it is implementation-history language and makes Channels look like one caller path among many instead of the reachability surface.
- Making every runtime entry, including schedules and subagents, into a synthetic Channel was rejected for V1 because internal calls do not always have reachability, admission, or delivery behavior worth declaring as Channels.
- Naming the identity Channel Actor was rejected because the same trusted principal can come from Auth, app routing, schedules, subagents, or fallback runtime behavior, not only Channels.
- Filesystem channel registration was rejected as the primary API because Agent reachability should be inspectable from the Agent Definition.

## Consequences

Official Chat Adapter support means Channel Kind helpers, setup diagnostics, and webhook wiring for Vercel-maintained Chat SDK adapters while keeping `@chat-adapter/*` packages explicit application dependencies. Stream is an official Channel Kind for app-owned AI SDK UI-message stream routes, so surfaces such as Portal Ask AI declare route metadata and trusted input mapping through `stream({ route })` instead of a sibling route helper. GitHub is an official Channel Kind for verified GitHub App or webhook delivery, event facts, installation context, actor mapping, Channel Delivery Admission, and supported Channel Delivery Effects for triggering events; product-specific commands, review artifacts, and browser review behavior stay application-owned. GitHub pull-request helpers may parse `/review`-style comment facts and apply reaction, reply, or status effects, but app code still owns command admission and trusted actor checks. Shared delivery effect vocabulary should stay generic, such as reactions, replies, and statuses, with platform-specific behavior owned by each Channel. Access, Rate Limit, prompt behavior, lifecycle hooks, and app code should read `context.actor`; `context.invoker` remains a compatibility alias.

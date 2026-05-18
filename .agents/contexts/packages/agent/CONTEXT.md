# Agent Package

Agent Package names ownership boundaries for `@vitehub/agent`.

## Language

**Agent Package**:
The package that owns Agent definitions, Agent runtime behavior, and Official Agent Capabilities.
_Avoid_: Chat package, capability package

**Chat Runtime Owner**:
The Agent Package role that hides Chat SDK runtime state behind ViteHub-owned Chat behavior.
_Avoid_: Chat SDK adapter owner, state adapter package

## Relationships

- The **Agent Package** owns Chat as an Official Capability.
- The **Agent Package** owns Chat State configuration.
- The **Agent Package** does not expose Chat SDK state adapters as public API.
- The **Agent Package** can use Workspace and KV package primitives for Chat State.

## Example Dialogue

> **Dev:** "Should `@vitehub/agent` let users pass a Chat SDK state adapter?"
> **Domain expert:** "No. The **Agent Package** is the **Chat Runtime Owner** and should expose ViteHub-managed Chat State instead."

## Flagged Ambiguities

- Chat runtime ownership was considered part of a separate Chat package - resolved: the **Agent Package** owns Chat runtime behavior.
- Chat State selection was considered as an application-level registry - resolved: the **Agent Package** configures Chat State per Chat Capability for v1.

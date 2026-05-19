# Agent Package

Agent Package names ownership boundaries for `@vitehub/agent`.

## Language

**Agent Package**:
The package that owns Agent definitions, Agent invocations, and Agent capability composition.
_Avoid_: Chat package, runtime package

**Agent Route Owner**:
The Agent Package role that exposes discovered Agents over HTTP when routes are enabled.
_Avoid_: Nitro route package, adapter owner

**Agent Adapter Boundary**:
The package boundary where provider-specific model adapters meet ViteHub Agent runtime behavior.
_Avoid_: Provider package, model package

## Relationships

- The **Agent Package** owns Agent Definition shape.
- The **Agent Package** owns Agent invocation handling.
- The **Agent Package** owns Agent capability composition.
- The **Agent Route Owner** is the Agent Package when generated Agent routes are enabled.
- The **Agent Adapter Boundary** keeps provider-specific model options behind Agent behavior.
- Shared runtime capabilities, approvals, and tracing belong to the Runtime Package.

## Example Dialogue

> **Dev:** "Should a model provider decide how ViteHub resolves workspace tools?"
> **Domain expert:** "No. That crosses the **Agent Adapter Boundary**. The provider handles model calls; the **Agent Package** owns Agent runtime behavior."

## Flagged Ambiguities

- Agent routes were considered generic Nitro routes - resolved: generated Agent routes belong to the **Agent Package**.
- Provider adapters were considered owners of runtime behavior - resolved: adapters sit behind the **Agent Adapter Boundary**.

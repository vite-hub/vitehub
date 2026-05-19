# Sandbox Package

Sandbox Package names ownership boundaries for `@vitehub/sandbox`.

## Language

**Sandbox Package**:
The package that owns isolated execution Definitions, sandbox runs, and sandbox provider integration.
_Avoid_: Shell package, workflow package

**Sandbox Definition**:
A portable declaration of isolated work that can run through a Sandbox Provider.
_Avoid_: Runtime command, provider sandbox

**Sandbox Run**:
One runtime execution of a Sandbox Definition.
_Avoid_: Workflow run, shell command

**Sandbox Provider**:
The backend that creates or reuses isolated execution environments.
_Avoid_: Sandbox Definition, runtime helper

**Sandbox Payload**:
The input value passed to a Sandbox Run.
_Avoid_: Request body, environment config

**Sandbox Identity**:
An optional stable identity used when a provider can reuse an underlying sandbox environment.
_Avoid_: Sandbox name, Definition name

## Relationships

- The **Sandbox Package** owns **Sandbox Definitions**.
- A **Sandbox Definition** can receive a **Sandbox Payload**.
- A **Sandbox Run** executes one Sandbox Definition.
- A **Sandbox Provider** backs Sandbox Runs.
- Sandbox Provider selection belongs to Integration Options.
- **Sandbox Identity** belongs to Invocation Options when supplied per run.

## Example Dialogue

> **Dev:** "Should the provider be passed every time we call a sandbox?"
> **Domain expert:** "No. The **Sandbox Provider** changes generated wiring, so provider selection belongs to Integration Options. A **Sandbox Identity** can be per-run."

## Flagged Ambiguities

- Sandbox provider selection was considered a runtime call option - resolved: provider selection is Integration Options when it affects generated output or bindings.
- Sandbox identity was considered the Definition name - resolved: **Sandbox Identity** is an optional provider reuse hint, not the portable Definition identity.

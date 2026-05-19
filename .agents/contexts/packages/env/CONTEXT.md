# Env Package

Env Package names ownership boundaries for `@vitehub/env`.

## Language

**Env Package**:
The package that owns typed environment declarations, diagnostics, generated env access, and secret masking.
_Avoid_: Dotenv wrapper, provider secret manager

**Env Declaration**:
The typed declaration of one environment value.
_Avoid_: Process env read, config property

**Build Env**:
Environment values resolved for Vite build and transform usage.
_Avoid_: Runtime secret, server config

**Runtime Env**:
Environment values resolved for server runtime usage.
_Avoid_: Public build value, compile-time define

**Env Source**:
An origin that can provide an Env Declaration value.
_Avoid_: Provider, adapter, dotenv file

**Secret Env**:
A Runtime Env value that diagnostics must mask.
_Avoid_: Private build value, hidden config

## Relationships

- The **Env Package** owns **Env Declarations**.
- **Build Env** belongs to Vite integration.
- **Runtime Env** belongs to Nitro integration.
- A **Secret Env** is a Runtime Env value.
- An **Env Source** can provide an Env Declaration value.
- Generated env access should preserve the difference between Build Env and Runtime Env.

## Example Dialogue

> **Dev:** "Can a server token be exposed through the Vite build virtual module?"
> **Domain expert:** "No. That is **Runtime Env**, and if it is sensitive it is **Secret Env**."

## Flagged Ambiguities

- Build-time and server runtime values were considered one config surface - resolved: use **Build Env** and **Runtime Env**.
- Secret handling was considered provider-specific - resolved: **Secret Env** is ViteHub language for values diagnostics must mask.

# DevTools Package

DevTools Package names ownership boundaries for `@vitehub/devtools`.

## Language

**DevTools Package**:
The package that owns the ViteHub DevTools shell integration and shared DevTools registration helpers.
_Avoid_: Agent DevTools package, chat client package

## Relationships

- The **DevTools Package** owns the ViteHub DevTools Integration.
- The **DevTools Package** owns shared DevTools Feature Registration helpers.
- Feature packages own their own DevTools Features and DevTools Bridges.

## Example Dialogue

> **Dev:** "Should `@vitehub/agent` expose the Vite plugin that registers the ViteHub DevTools shell?"
> **Domain expert:** "No. The **DevTools Package** owns the shell integration; Agent only owns its Chat DevTools Feature."

## Flagged Ambiguities

- The Agent Package was considered the owner of the DevTools shell because Chat is the first feature - resolved: the **DevTools Package** owns the shell integration.

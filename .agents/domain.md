# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`.agents/CONTEXT-MAP.md`**. It points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`.agents/adr/`** for agent-facing architectural decisions, if present.
- Context-local `adr/` directories for decisions scoped to a specific context, if present.

If any of these files don't exist, proceed silently. Don't flag their absence or suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File Structure

This is a multi-context repo:

```text
/
+-- .agents/
    +-- CONTEXT-MAP.md
    +-- domain.md
    +-- adr/
    +-- contexts/
        +-- framework-integrations/
        +-- capabilities/
        +-- agents/
        +-- packages/
```

## Use The Glossary's Vocabulary

When your output names a domain concept, use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal that the language needs another `/grill-with-docs` pass.

## Flag ADR Conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding.

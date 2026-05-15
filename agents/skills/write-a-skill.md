# Write A Skill

Use this guidance when an agent needs to help a user create or update a ViteHub Skill.

## Process

1. Gather requirements:
   - What task or domain does the Skill cover?
   - What user requests should trigger it?
   - What behavior should it change?
   - Are examples or reference material needed?

2. Draft the Skill in conversation:
   - Propose the `name`.
   - Propose the `description`.
   - Propose the Markdown body.
   - Ask the user to confirm before writing.

3. Write the Skill after confirmation:
   - Prefer `skills/<name>.md`.
   - Use `skills/<name>/SKILL.md` only when supporting files are needed.
   - Use the developer-exposed workspace write tool when available; ViteHub validates Skill file writes at runtime.

## Skill Shape

```md
---
name: skill-name
description: Brief third-person description. Use when specific triggers apply.
---

# Skill Name

Concise instructions for the behavior this Skill adds.
```

## Description Rules

The description is routing text. It is shown in the compact skill index so the agent can decide when to read the full Skill.

- Keep it under 1024 characters.
- Write it in third person.
- Include `Use when ...` with concrete triggers.
- Do not mention implementation-specific tool names.

Good:

```txt
Track receipts from messages and attachments. Use when the user sends receipts, invoices, or expense screenshots.
```

Bad:

```txt
Helps with expenses.
```

## Review Checklist

- Description includes `Use when`.
- Name matches the file basename or folder name.
- Body is concise and concrete.
- The Skill does not name specific implementation tools.
- The user explicitly confirmed the draft before writing.

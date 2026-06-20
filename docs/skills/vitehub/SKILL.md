---
name: vitehub
description: Build ViteHub server primitives and agents with the public docs. Use when working with ViteHub Runtime Helpers, server primitives, Vite integrations, Provider Output, Workspaces, Sources, Agent Definitions, Agent Drivers, Capabilities, or host deployment on Nuxt, Nitro/UnJS, Vercel, Cloudflare, or Node.
---

# ViteHub

Use this skill to build with ViteHub server primitives and Agents from the public docs without loading the whole site upfront.

## Start

Read [references/docs.md](references/docs.md), then load only the smallest relevant docs page.

Use this order:

1. Start from `https://vitehub.dev/llms.txt` for the docs map.
2. Read the matching raw Markdown page from `https://vitehub.dev/raw/docs/...`.
3. Check local project files after the docs page, not before.
4. Cite the docs URL or local file path when copying guidance into code or explanations.

## Choose The Track

Use the ViteHub vocabulary:

- **Server primitive** is a ViteHub-owned server capability for app/server code.
- **Runtime Helper** is the stable server-code import for a primitive.
- **Provider Output** is host-specific generated output.
- **Agent Definition** declares one server-side Agent.
- **Agent Driver** selects model-backed, harness-backed, or custom-run-backed execution.
- **Capability** adds one named Agent ability.
- **Workspace** owns persistent file-tree state.
- **Source** provides read-only context.

For ordinary server behavior, start with the server primitive:

1. Install only the packages the app uses.
2. Register each package's Vite Integration.
3. Define named work only when the primitive needs discovery.
4. Call the primitive from app/server code through Runtime Helpers.
5. Inspect generated Provider Output when host behavior matters.

For model, harness, or custom Agent behavior, add the Agent track after the primitive track is clear:

1. Add an Agent Definition.
2. Select one Agent Driver.
3. Add Workspace and Sources for context.
4. Attach Capabilities only when the Agent should receive that specific ability.
5. Keep host-specific behavior behind ViteHub package docs unless the host boundary is the task.

## Guardrails

- Do not expose a primitive to a model just because the app uses it.
- Do not add an Agent Definition when direct server code and a Runtime Helper solve the task.
- Do not add root `tools`, `skills`, or `sandbox` Agent Definition fields; use Capabilities and Agent Driver boundaries.
- Do not copy docs into prompts when a raw docs URL is enough.
- Prefer current docs over memory for package names, import paths, and option shapes.
- Treat Nuxt, Nitro/UnJS, Vercel, Cloudflare, and Node as host/framework targets, not separate ViteHub product models.

## Verify

For code changes, run the smallest check that proves the touched behavior:

- docs-only changes: `pnpm --dir docs build`
- package changes: the package test or typecheck command nearest the edit
- integration changes: inspect generated `.vitehub` output and run the relevant build/dev proof

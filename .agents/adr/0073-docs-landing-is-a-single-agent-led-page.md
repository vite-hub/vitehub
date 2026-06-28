# Docs Landing Is A Single Agent-Led Page

The ViteHub docs site presents one landing page at `/` rather than separate agent and server-primitive landings. The page leads with agents as the wedge, then gives server primitives equal real estate as the foundation agents are built on; the marketing page is removed from `/docs/` so `/docs/server-primitives` returns to being the docs section overview.

The hero shows three realistic Agent Definitions as a file tree: `pr-reviewer` (harness driver, git + `mcp()` browser + workspaceShell, GitHub channel), `support` (model driver, Workspace sources + the `access()` scope capability, web chat — modeled on the quiver support agent), and `research` (model driver, `webSearch()` + `subagents()`). Browser access is wired through `mcp()`, not a first-class capability.

The single page is structured as: hero (the three Agent Definitions above, in-hero install, the `vitehub()` preset), an "any host" portability proof (three curated code snippets plus host badges: Cloudflare, Vercel, Netlify, Deno, Node, Docker, Fly.io), a Capabilities + Workspace + Instruction Document novelty beat, a per-primitive grid with microanimations, the reused interactive showcase with "Powered by …" library/provider labels, and a closing CTA on composability, provider independence, and "just a Vite plugin".

## Considered Options

- Two co-equal landings (agent root + server-primitives secondary) was rejected: two roots cannot be equal because one is always reached from the other, and it splits the "what is this" story. A single page makes the pillars equal through equal real estate.
- Keeping the marketing page at `/docs/server-primitives` was rejected because the custom Vue page shadows the content route and hides the real docs overview.

## Consequences

- Landing claims must track shipped code. Specifically: instructions are **Markdown Instruction Documents** composed by Instruction Composition, never "MDX" (see [0072](0072-instruction-documents-compose-model-instructions.md)); the `database` primitive is SQLite/libSQL/Cloudflare D1 today, not Postgres/MySQL; "Markdown instructions across drivers" may only be claimed once harness-backed drivers consume instruction documents (not true at time of writing).
- Per-primitive microanimations are ported from `vitehub-old` (`docs/app/components/landing/FeatureIllust.vue`); seven primitives reuse existing animations, five (auth, env, workspace, source, shell) are authored new.

# Docs Readiness Preserves Agent-First Public Direction

ViteHub docs readiness is judged by whether agents and humans can use the same compact docs surface to build with Agent Definitions, server primitives, and provider-agnostic runtime behavior on any host. The public docs should make those three anchors obvious, use Better Auth/Fumadocs-like navigation and writing density, keep provider-aware callouts close to affected setup or runtime behavior, and keep public options concise and checked against current package source.

## Considered Options

- Treating docs readiness as a landing-page copy pass was rejected because the public promise needs all three anchors: agents, server primitives, and any host.
- Copying Better Auth, Fumadocs, or Eve literally was rejected because ViteHub should keep their useful navigation and composition patterns while using ViteHub vocabulary and claims.
- Expanding every possible page or provider note was rejected because docs readiness includes deleting, hiding, or shortening pages that do not help a concrete user or agent task.

## Consequences

The landing page and first viewport should make agents, server primitives, and any-host support obvious. Exact copy can change, but those anchors should not disappear.

Docs navigation should stay compact and task-first: one combined sidebar, a visible page outline where the shell supports it, readable density, and reference pages that a human or agent can scan without a giant prompt dump.

Provider and framework differences belong close to the affected setup step, option, generated Provider Output, Vite Integration, Provider Selection, credential, or production-readiness behavior. Do not spread generic provider warnings everywhere.

Public examples, exports, defaults, option names, and package boundaries must be checked against current source before they become reference docs.

AI-readable affordances such as canonical Markdown, `llms.txt`, copy-markdown actions, and scoped prompt blocks are readiness requirements only where they serve real product tasks. The exact H1, exact page sequence, and prompt blocks on every page are not doctrine.

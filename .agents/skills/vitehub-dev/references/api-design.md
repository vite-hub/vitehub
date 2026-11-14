# Design a public API

Read this when a change adds, renames, reshapes, or removes anything that a developer or an Agent can call, import, or configure.

## The guess test

Before you read our docs, write the call that an Agent would guess for the task. If our API differs from the guess, change our API. A wrong guess is a design bug, not a docs bug.

- Use plain names that a user would guess: `defineChoices`, not `defineFilters`, when the thing is a list of choices. Prefer names that the stack already uses.
- Use the project language from `AGENTS.md` (Server Primitives, Agent Definitions, Capabilities, Workspaces, Sources) and nothing invented next to it.
- Use standards before our own shapes: native `Request` and `Response`, fetch handlers such as `{ fetch(request) }`, Standard Schema, `.well-known` paths. Adopt an emerging standard early when it is likely to win. Reuse an endpoint or format that already exists before you add one.
- Prefer inferred types that make invalid states hard to write. A wrapper that only renames or casts does not earn its place.

## The right amount of abstraction

Aim for the abstraction that fits every real case, and no more.

- Add a seam only when a second user exists or is certain. A seam with one user is cost.
- Resolve configuration into one state. Several flags that interact create states that no one tests.
- Avoid magic. When ViteHub cannot know how the developer's data maps to ours, let the developer write that bridge in plain code, and give them the primitive it calls.
- Keep the first version simple. Fit the real case first, then generalize when a second case arrives.

## Primitive or product

A behavior belongs in ViteHub when developers would build it the same way in many apps, and when it must behave the same on every host. Then make it a primitive that composes with the other primitives, and that a developer turns on or off with one config key.

A behavior stays in the consumer when it is one app's workflow. Do not bake a consumer's choices (its name, its vendor, its layout) into ViteHub. Give the consumer a slot, a hook, or an option instead.

New primitives compose existing ones where they fit. A CMS uses Content, Database, and Auth instead of its own storage. When a hard dependency on another primitive adds friction, accept a plain connection instead.

Presets are generic and work for every project. Choices that belong to one project go in its template or app config.

Dogfood the primitive. ViteHub's own docs and first-party apps use the new feature, and first-party templates use ViteHub's env and secret primitives instead of vendor variables. A template is a reference app: it shows the best way to use ViteHub.

## Defaults and opt-in

- Zero config must give a working local result, with dev emulation where a provider has no local mode, so that Agents can test.
- When production needs a choice that changes durability, cost, or security, require it explicitly. Never fall back silently. Fail at build or define time with an error that has a real `why` and `fix` (see Errors in `CONTRIBUTING.md`).
- Powerful or risky behavior is opt-in. Public access has one spelling: `access: "public"`.
- A default vendor (GitHub, a model provider, a deploy service) must work without setup and be replaceable with one option. GitHub CI is never the default deploy path.
- A feature that is off adds no install weight, no bundle bytes, and no startup work. Measure this when you add a dependency or an import.

## Hosts

Host and provider differences live inside ViteHub. The developer writes the same code for Node, Cloudflare, Vercel, Netlify, and Deno. Build for Nuxt 5 and Nitro 3 only. When a host cannot support a feature, say so at build time and in the docs.

## Inspection

Each primitive exposes its state through code and the CLI first. The Console builds on that same inspection API. Operator tasks, such as reading a primitive's data or acting on a run, belong in the Console, not in custom pages inside each app.

## Security and authority

Keep authority explicit through Capabilities, grants, Workspace access, and Sources. A guard returns a grant and the action requires it. State durability, isolation, persistence, cost, and production readiness. Never hide them behind a familiar interface.

## Breaking changes

Breaking changes are welcome when they make the final contract clearer.

1. Find the real callers: run `vp run consumers:check` (see Pull requests in `CONTRIBUTING.md`) and search the repository.
2. Migrate those callers to the new contract in the same change, or in a stacked pull request.
3. Delete the old path. No alias, no deprecation warning, no version flag.
4. When real projects depend on the old name, keep it only until a codemod in `@vite-hub/codemods` moves them.
5. Mark the title with `!` and show the before and after code at the top of the pull request body, so a human reviews the new shape.

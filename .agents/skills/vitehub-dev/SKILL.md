---
name: vitehub-dev
description: How we build ViteHub itself. Use before you design, change, review, or document code in the vite-hub/vitehub repository or a first-party ViteHub package, including a public API, a Server Primitive, a breaking change, a docs page, the Console, or a pull request. To build an app with ViteHub, use the `vitehub` skill instead.
---

# Build ViteHub

This skill holds how the maintainers decide. `AGENTS.md` has the repository rules and `CONTRIBUTING.md` has the procedures and commands. When a direct request from a maintainer disagrees with this skill, the request wins.

## The bar

Every change meets these, whatever its size.

1. **First try.** Agents write most ViteHub apps. If an Agent cannot use an API correctly on the first try, the API is wrong. Fix the API before you add docs that explain it.
2. **Primitive first, thin consumers.** When an app, a template, or a first-party project needs a workaround, the gap is in ViteHub. Fix it in the package that owns the behavior so every developer gets it.
3. **Break it now.** ViteHub is 0.0.x with few users. Choose the contract that is best for the long term, migrate the real callers, and delete the old path.
4. **Small public surface.** Every export, option, subpath, package, and CLI command must earn its place. Delete what has no behavior. One right way beats two good ways.
5. **Works out of the box.** Zero config gives a working local result, with nothing to maintain by hand: generate what can be generated. A feature that is off costs nothing in install size, bundle bytes, or startup time.
6. **No lock-in.** A default vendor, forge, login, or model provider is fine when it works without setup, but the developer can replace it with one option. Host and provider differences belong in ViteHub, not in the developer's code.
7. **Inspectable.** Every runtime feature can be inspected through code or the CLI. The Console helps, but it is never the only path.
8. **Proven where developers feel it.** A change is done when it works end to end in a real project, not when it compiles. Claims about speed or size come with before and after numbers.
9. **Speed now.** Ship many small pull requests and fix forward. Prefer a merged improvement over a perfect plan. Checks get strict before a release, and this rule changes when ViteHub has many users.

## Before you write code

1. **Read what was decided.** Search open and recently merged pull requests and issues for the same area. Another person or agent may own it, or a maintainer may have chosen a direction already. Done when you can name the related pull requests, or confirm that none exist.
2. **Research the design space.** Read how upstream (Nitro, H3, Nuxt, UnJS) and peers (NuxtHub, Better Auth, the provider SDKs, the closest competitor) solve the same problem, from their source. Copy what works. Done when you can name the closest existing design and say why ours matches it or differs.
3. **Find the owner.** Pick the package and layer that owns the behavior. Use what the stack already gives (H3 and Nitro utils, VueUse, Drizzle, Better Auth plugins, comark-ui) before you write new code. Before you blame upstream, check whether the behavior is by design.
4. **Reproduce or measure.** For a bug, write the failing test or script first. For performance or weight, record the baseline. Done when the problem is red or the baseline is written down.

## While you work

- **Decide routine choices yourself.** Pick the option that is best for the long term and say why in the pull request. Ask only for a decision that is genuinely a maintainer's, such as the name or shape of a new public API, and then recommend one option.
- **Answer questions first.** When a maintainer asks a question, pause and answer it before you continue.
- **Challenge the premise.** Ask whether the feature, option, or package should exist at all. Removing something often solves the problem.
- **Fix the class.** When you find a bug, search the repository for the same pattern and fix every instance.
- **Make the rule a check.** When a mistake keeps coming back, turn the rule into a type, a test, or a Vite Doctor rule, not a sentence in the docs.
- **Write code a person would write.** Remove defensive branches for impossible states, copied type guards, and try and catch blocks that hide errors.

## Public API

Apply this section when a change adds, renames, reshapes, or removes anything that a developer or an Agent can call, import, or configure.

### The guess test

Before you read our docs, write the call that an Agent would guess for the task. If our API differs from the guess, change our API. A wrong guess is a design bug, not a docs bug.

- Use plain names that a user would guess: `defineChoices`, not `defineFilters`, when the thing is a list of choices. Prefer names that the stack already uses.
- Use the project language from `AGENTS.md` (Server Primitives, Agent Definitions, Capabilities, Workspaces, Sources) and nothing invented next to it.
- Use standards before our own shapes: native `Request` and `Response`, fetch handlers such as `{ fetch(request) }`, Standard Schema, `.well-known` paths. Adopt an emerging standard early when it is likely to win. Reuse an endpoint or format that already exists before you add one.
- Prefer inferred types that make invalid states hard to write. A wrapper that only renames or casts does not earn its place.

### The right amount of abstraction

Aim for the abstraction that fits every real case, and no more.

- Add a seam only when a second user exists or is certain. A seam with one user is cost. A replaceable vendor (bar rule 6) always counts as a second user.
- Resolve configuration into one state. Several flags that interact create states that no one tests.
- Avoid magic. When ViteHub cannot know how the developer's data maps to ours, let the developer write that bridge in plain code, and give them the primitive it calls.
- Keep the first version simple. Fit the real case first, then generalize when a second case arrives.

### Primitive or product

A behavior belongs in ViteHub when developers would build it the same way in many apps, and when it must behave the same on every host. Make it a primitive that composes with the other primitives, and that a developer turns on or off with one config key.

A behavior stays in the consumer when it is one app's workflow. Keep a consumer's choices (its name, its vendor, its layout) out of ViteHub. Give the consumer a slot, a hook, or an option instead.

- New primitives compose existing ones where they fit. A CMS uses Content, Database, and Auth instead of its own storage. When a hard dependency on another primitive adds friction, accept a plain connection instead.
- Presets are generic and work for every project. Choices that belong to one project go in its template or app config.
- Dogfood the primitive. ViteHub's own docs and first-party apps use the new feature. First-party templates use ViteHub's env and secret primitives instead of vendor variables. A template is a reference app: it shows the best way to use ViteHub.

### Defaults and opt-in

- Give zero config a working local result, with dev emulation where a provider has no local mode, so that Agents can test.
- Turn on useful features that are safe and cheap. Powerful or risky behavior is opt-in. Public access has one spelling: `access: "public"`.
- When production needs a choice that changes durability, cost, or security, require it explicitly. Fail at build or define time with an error that has a real `why` and `fix` (see Errors in `CONTRIBUTING.md`). A silent fallback is a bug.
- GitHub CI is one deploy option, never the default.
- Measure install weight, bundle bytes, and startup when you add a dependency or an import.

### Hosts, inspection, and authority

- The developer writes the same code for Node, Cloudflare, Vercel, Netlify, and Deno. Build for Nuxt 5 and Nitro 3 only. When a host cannot support a feature, say so at build time and in the docs.
- Each primitive exposes its state through code and the CLI first. The Console builds on that same inspection API. Operator tasks, such as reading a primitive's data or acting on a run, belong in the Console, not in custom pages inside each app.
- Keep authority explicit through Capabilities, grants, Workspace access, and Sources. A guard returns a grant and the action requires it. State durability, isolation, persistence, cost, and production readiness openly.

### Breaking changes

Breaking changes are welcome when they make the final contract clearer.

1. Find the real callers: run `vp run consumers:check` (see Pull requests in `CONTRIBUTING.md`) and search the repository.
2. Migrate those callers to the new contract in the same change, or in a stacked pull request.
3. Delete the old path in the same change: no alias, deprecation warning, or version flag. The one exception: when a project outside this repository uses the old name, keep it as a plain alias until a codemod in `@vite-hub/codemods` moves that project, then delete it.
4. Mark the title with `!` and show the before and after code at the top of the pull request body, so a human reviews the new shape.

## Docs

Apply this section to docs pages, READMEs, examples, skills, error messages, and CLI output. `CONTRIBUTING.md` has the page structure, the comark-ui blocks, the snippet check, and the agent-only blocks.

Every page serves two readers at once: a beginner who has never used ViteHub, and a coding Agent that copies the code. A page that works for the beginner usually works for the Agent. Add an agent-only block only when a real Agent run fails without it.

**Less text.** Too much text is the most common problem in ViteHub docs.

- Cut until the page only has what the reader needs to succeed. Move edge cases to a collapsible block or the reference page.
- Lead with a working example. Show the Nuxt version first, with tabs for Vite and Nitro when they differ.
- After a code block, explain only the lines that the reader must understand.
- One page, one task. When a page grows long, split it.

**Plain words.**

- Write in ASD-STE100 English. When in doubt, write so that a 15 year old understands it.
- Explain each term the first time, in one plain sentence. Replace internal words, such as "seam", "projection", or "materialize", with plain ones.
- Explain a tool the reader already knows, such as ESM or pnpm, only when the step fails without it.
- Say what the feature does, and say what it does not do. Claim nothing you have not run.
- For tone and length, copy good docs: Nuxt, evlog, and executor.sh.

**Real examples.**

- Take examples from real use cases, with a realistic app, real names, and real data, in place of `foo`, `bar`, or a todo list.
- Every code block runs when an Agent copies it, with no type hacks such as `as never` or `as any`.
- Show the real output of each command, copied from a real run.

**Docs ship with the code.**

- Update docs and the package README in the same pull request as the behavior, written as if the change were already released.
- For a new primitive or a large feature, write the docs pages first. They show whether the API is easy to explain. If it is hard to explain, change the API.
- An error message is docs: each code names the problem, the real cause, and the fix.
- Skills are minimal but give an Agent enough to succeed. Generated skill references come from docs blocks, so edit the block, not the generated file. When you change how docs or skills are served, start a fresh Agent session and check that it finds them.

## Interfaces

Apply this section to the Console, the docs site, hero visuals, and any other interface. `CONTRIBUTING.md` has the visual rules under "Visual and design work".

**Reuse before you design.**

- Start from the styles and components that ViteHub already has: the ViteHub theme, `@vite-hub/ui`, and comark-ui. Reuse their backgrounds, borders, and card styles.
- When a pattern is missing, copy a product that does it well (T3 Code, Linear, the Vercel and Cloudflare dashboards, shadcn). Read its current source or screenshots, not your memory of it.
- Use the ViteHub icon set for primitives and Lucide for everything else, all in the outline style.
- Fix a visual bug in the shared component, for every component that has it, not in one page.

**Simple by default.**

- Design each screen around its main task. Make the main action easy to find and cut chrome that does not serve it.
- Show little by default and put power one click away, such as in a popover or a details panel.
- Keep state in the URL, so a link opens the same view.
- Hide empty UI. A button that has nothing to do is noise.
- Use fewer borders. Separate with spacing, without wasting space.

**No visible glitches.**

- Reserve space for content that loads, so nothing shifts.
- Give every view a real loading, empty, and error state.
- Show feedback where the action happens. Update optimistically. Use a toast only for an error that has no better place.

Check the interface in a browser at the widths and themes it affects before you report it. Attach before and after images to the pull request, and a short video for motion or timing.

## Shipping

Apply this section when you open, update, or review a pull request, or when a consumer needs a fix. `CONTRIBUTING.md` has the commands and the pull request rules.

**Prove it end to end.**

- A bug fix starts with a test or script that fails on `main`.
- Test in a real project, beyond mocks. For a framework change, create a Nuxt 5 app outside the repository, install the branch build from pkg.pr.new, and run it in dev and in production.
- Test every host, provider, and configuration form that the change affects.
- For speed, size, or startup claims, measure on the base and on the branch with the same build. Put both numbers in the pull request.

**Fix it where it belongs.** When a consumer (a template, an app, a first-party project) hits a ViteHub gap:

1. Prove the smallest fix in the consumer with `pnpm patch`, or with a pkg.pr.new build of the branch.
2. Open the fix in ViteHub with focused tests.
3. Update the consumer to the fixed version and remove the patch.

The fix is done when the consumer works without the patch. Report every paper cut you hit in ViteHub along the way, and give each one a pull request.

**Pull request shape.**

- One concern per pull request. Independent bugs get independent pull requests. A fix to CI gets its own pull request.
- Related pull requests form a stack. Check that the stack works when all of it merges.
- Commit the tests that prove the behavior, not every test you can think of. Keep committed end-to-end tests fast and few. The host checks above can be manual runs that you report in the pull request.
- Start the body with the problem, then the fix in plain words, then what you verified and what you did not. A public API change shows the before and after code at the top.

**Review.**

- Challenge a large plan or a new public API before you build it. Ask a second reviewer whether a smaller design solves the same problem.
- In review, report real defects and simpler designs. When fixes do not converge after a few rounds, propose a simpler contract instead of more cases.

**Keep work moving.**

- Keep good pull requests open until they merge. Close one only when it will not merge, and say why.
- Review and merge a new contributor's pull requests quickly, so they keep contributing. When you squash one, credit them as co-author.
- On third-party repositories, draft the issue or pull request text and hand it over. Open it only when you are asked.
- Keep durable research in the pull request or issue that it supports, so later contributors find it.

## Before you report done

- Each affected host, provider, and configuration form was tested.
- Docs and the package README match the new behavior.
- Every finding has a pull request or is on main. Nothing stays only in the chat.
- The report says what changed, what you verified with the exact commands, and what you did not verify.

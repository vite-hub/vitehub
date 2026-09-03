I'm Maxi. You're my agent. We will work together often, so these preferences should guide our work.

I love to build. I want complex systems to feel simple. I look for ways to remove complexity without hiding real constraints. I welcome bold ideas when they produce a clearer result.

Quick rules before the details:

1. Keep writing short and easy to scan.
2. Always use ASD-STE100 Simplified Technical English.
3. Avoid LLM language, em dashes, filler, and long status recaps. Speak simply.

## Coding preferences - general

- Keep things simple. Use YAGNI unless I ask for more.
- Use types to make invalid states hard to represent.
- Propose bold ideas when they can give us a much better result.
- Be careful with destructive actions that I did not request.
- Write focused tests for changed behavior. Do not add tests only to preserve deleted behavior or lock in an arbitrary visual constant.
- Use concise comments above functions or classes when they clarify use or a non-obvious constraint. Update comments when the code changes.
- Use existing libraries when they fit. Keep the product's developer experience in charge.

## Coding preferences - TypeScript

- Prefer inferred types. Do not use `any`.
- Model data so a change flows through inference instead of repeated annotations.
- Avoid one-line wrappers that only cast a value.
- Write TypeScript that uses the language well. Do not copy patterns from a dynamically typed language.
- Use this repository's Vite, Nuxt, Vue, and pnpm choices. Do not replace the stack without a clear task requirement.

## Questions are read-only

A capability or design question asks for an answer, not a change. Answer it and offer the next action. Do not edit files or change external state.

A direct request phrased as a question, such as "can you fix this?" or "can you create this pull request?", authorizes the named action.

## Match ceremony to the task

- Use one agent for work it can finish in one pass.
- Use subagents for broad research, independent review, or parallel work with separate ownership.
- State file and repository ownership before parallel work starts.
- The latest instruction wins. When I say "continue," inspect the current branch, pull request, worktree, consumer, and deployed state before you resume.
- If a repository rule conflicts with the task, explain the conflict before you act. Ask me to approve the exception.

## Visual and design work

- Make interface, layout, and copy changes directly. Create a mock only when I ask.
- When T3 Code is the named reference, inspect its current source and screenshots. Do not copy it from memory.
- Use Nuxt UI components when they fit. Match ViteHub's compact spacing and T3 Code's interaction patterns.
- Prefer dense layouts, small icons, minimal copy, true black in dark mode, white primary text, and few borders.
- Avoid decorative cards, pills, shadows, and subtitle rows.
- Avoid continuously repainting animations such as pulse, shimmer, blur, and spinning loaders.
- Check overflow, narrow widths, long tab lists, empty states, keyboard access, and panel resizing when they apply.
- Ask before opening a browser or starting a development server unless the task already requests it.

## Blast radius

- Before cross-repository or live-system work, state the exact repository, path, branch or pull request, and live target.
- Mentioning another repository does not authorize changes there. An explicit request that names the repository does.
- Never touch production, live databases, a development server that a maintainer is using, deployments, or external accounts without explicit approval.
- Preserve changes made by other people or agents. Inspect collisions and adapt around them.
- Remove worktrees, branches, and temporary files created by the task after their remote state is safe. Never remove pre-existing work without explicit approval.

## Pull requests

- Do not push changes, create a pull request, or update a pull request unless I ask.
- Confirm the destination repository and check for an existing pull request before you open one.
- Rebase onto the latest `main` before opening a pull request.
- Open a real pull request, not a draft.
- Keep one concern per pull request unless I ask to combine work.
- Use the repository's conventional title style, for example `fix(workspace): preserve source grants`.
- Start the body with the problem, then explain the fix in plain language. Omit commit hashes and boilerplate sections unless they help the reviewer.
- End the body with the model and harness used.
- Interface pull requests need before and after images. Changes to motion or timing need a short video. Upload this evidence to GitHub. Do not commit pull-request-only media.
- When monitoring a pull request, inspect checks and comments newer than the last push. Verify bot findings against the source. Fix real issues and explain false positives. Separate code failures from infrastructure failures. Stay quiet when nothing changed. Stop when review bots and required checks are green on the latest commit.
- Merge only when my request gives that authority.
- Never force-push.

---

# ViteHub

## Current status

ViteHub is in active development. Optimize for the final contract. Breaking changes, removal of legacy code, and dropped backward compatibility are welcome when they make that contract clearer.

## Project direction

ViteHub provides server primitives for any host. It also provides portable Agents across Vite hosts, with Better Auth-level developer experience.

Use these references:

- Better Auth for composition. Plugins and Capabilities should fit naturally around Agent Definitions.
- UnJS for host-independent runtime behavior, discovery, storage, scheduling, invocation, inspection, and deployment.

## Build primitives, not everything

Build reusable primitives that developers should not have to recreate. These include Agent Definitions, Capabilities, Workspaces, Sources, runtime invocation, storage, scheduling, inspection, and framework integration.

Product-specific workflows belong in consumers when they can be built from ViteHub primitives. The Console is the exception for first-party inspection and debugging. It may expose ViteHub primitives, but runtime policy stays in the package that owns it.

## Fight for the obvious API

Build complex things as simply as possible. Simple and obvious are not always the same. Accept internal machinery when it makes the public contract behave as a developer or Agent would expect.

Normal work must not expose implementation details, framework details, or compatibility history. Put shared behavior at the ViteHub boundary that owns it. Preserve ViteHub abstractions over local convenience.

Before you preserve a legacy path, search this repository and known consumers for real callers. Migrate those callers to the final contract. Delete speculative compatibility unless the task requires it.

Treat a downstream workaround as evidence of a ViteHub gap unless it is product-specific.

## Agent-first runtime design

Every runtime feature must be inspectable through code or CLI. This includes generated state, bindings, discovered definitions, and provider output. A dashboard can help, but it must not be the only inspection path.

Familiar interfaces such as filesystems, tools, and shells are useful. Keep their contracts honest. State durability, isolation, security, persistence, cost, and production readiness explicitly.

## Before making changes

Reopen the latest cited issue, pull request body, screenshot, or consumer. State the exact outcome and the adjacent behavior that must stay unchanged.

For a contract change, name the affected variants and trace the value through its owner. Check definition or configuration, generated output, runtime behavior, and consumers. Verify each affected provider, framework, configuration form, and output mode.

When code owns resources or durable state, verify the applicable success, error, abort, cancellation, timeout, cleanup, restart, and concurrent reuse behavior at that boundary.

## Downstream patch loop

Use `pnpm patch` in a consuming project to prove the smallest downstream fix:

1. Patch the smallest downstream change.
2. Verify the real consumer flow.
3. Upstream the source fix with focused coverage.
4. Update the consumer to the fixed version and remove the patch.

The fix is complete when the consumer works without the patch. Retire combined patches one hunk at a time as their fixes land upstream.

## Verification

Use the smallest proof that covers the changed behavior. Run focused test files and the package-level lint, typecheck, or build tasks that apply. Do not run the full repository suite unless I ask or the change has repository-wide impact.

Backend behavior changes need focused tests. A claimed runtime fix must include the original reproduction or the nearest real flow.

## Worktrees and parallel work

Pull request work belongs in a dedicated worktree. Reuse the current task worktree when it is already isolated. Otherwise create one from the refreshed target base.

Assume other agents may be active. Preserve their changes. Inspect collisions and adapt around them instead of reverting them.

## Documentation and work artifacts

Do not commit temporary plans, raw thread exports, or agent scratch files. Use `.agents/research/` only for durable, cited research that supports a project decision.

Document user-visible behavior in `docs/content/docs/` and the affected package README when it is part of that package's contract. Keep documentation and code comments in sync with behavior.

## Language

"You" means the contributor reading this file. "Maintainers" means Maxi and the people building ViteHub. "Users" means developers building with ViteHub. "Agents" means the Agents those users define and run.

Use ViteHub framework language for `vite-hub`, `@vite-hub/*`, Agent Definitions, Capabilities, Workspaces, Sources, Agent Invocations, framework integrations, runtime behavior, and upstream design. Use package names for implementation ownership inside a package.

## Related repositories

Project source folders are separate Git repositories. Follow each repository's local instructions.

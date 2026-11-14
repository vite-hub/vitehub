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
3. **Break it now.** ViteHub is 0.0.x with few users. Choose the contract that is best for the long term, migrate the real callers, and delete the old path. Add no deprecation period or compatibility layer. Keep an old name only while a real project still uses it and a codemod is on the way.
4. **Small public surface.** Every export, option, subpath, package, and CLI command must earn its place. Delete what has no behavior. One right way beats two good ways.
5. **Works out of the box.** Zero config gives a working local result, with nothing to maintain by hand: generate what can be generated. Turn on useful features that are safe and cheap. Powerful or risky behavior is opt-in. A feature that is off costs nothing in install size, bundle bytes, or startup time.
6. **No lock-in.** A default vendor, forge, login, or model provider is fine when it works without setup, but the developer can replace it with one option. Host and provider differences belong in ViteHub, not in the developer's code.
7. **Inspectable.** Every runtime feature can be inspected through code or the CLI. The Console helps, but it is never the only path.
8. **Proven where developers feel it.** A change is done when it works end to end in a real project, not when it compiles. Claims about speed or size come with before and after numbers.
9. **Speed now.** Ship many small pull requests and fix forward. Prefer a merged improvement over a perfect plan. Checks get strict before a release, and this rule changes when ViteHub has many users.

## Before you write code

1. **Read what was decided.** Search open and recently merged pull requests and issues for the same area. Another person or agent may own it, or a maintainer may have chosen a direction already. Done when you can name the related pull requests, or confirm that none exist.
2. **Research the design space.** Read how upstream (Nitro, H3, Nuxt, UnJS) and peers (NuxtHub, Better Auth, the provider SDKs, the closest competitor) solve the same problem, from their source. Copy what works. Done when you can name the closest existing design and say why ours matches it or differs.
3. **Find the owner.** Pick the package and layer that owns the behavior. Use what the stack already gives (H3 and Nitro utils, VueUse, Drizzle, Better Auth plugins, comark-ui) before you write new code. Before you blame upstream, check whether the behavior is by design.
4. **Reproduce or measure.** For a bug, write the failing test or script first. For performance or weight, record the baseline. Done when the problem is red or the baseline is written down.

Then read the references that match the change:

| The change touches | Read |
| --- | --- |
| A public API, a new primitive, an option, a config key, a rename, or a removal | [references/api-design.md](references/api-design.md) |
| A docs page, README, example, skill, error text, or CLI output | [references/docs.md](references/docs.md) |
| The Console, the docs site, or any other interface | [references/interface.md](references/interface.md) |
| Opening, updating, or reviewing a pull request, or a fix that a consumer needs | [references/shipping.md](references/shipping.md) |

## While you work

- **Decide routine choices yourself.** Pick the option that is best for the long term and say why in the pull request. Ask only for a decision that is genuinely a maintainer's, such as the name or shape of a new public API, and then recommend one option.
- **Answer questions first.** When a maintainer asks a question, answer it before you act on it.
- **Challenge the premise.** Ask whether the feature, option, or package should exist at all. Removing something often solves the problem.
- **Fix the class.** When you find a bug, search the repository for the same pattern and fix every instance.
- **Make the rule a check.** When a mistake keeps coming back, turn the rule into a type, a test, or a Vite Doctor rule, not a sentence in the docs.
- **Write code a person would write.** Remove defensive branches for impossible states, copied type guards, and try and catch blocks that hide errors.

## Before you report done

- Each affected host, provider, and configuration form was tested.
- Docs and the package README match the new behavior.
- Every finding has a pull request or is on main. Nothing stays only in the chat.
- The report says what changed, what you verified with the exact commands, and what you did not verify.

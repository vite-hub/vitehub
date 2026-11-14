# Write docs

Read this when a change adds or edits a docs page, a README, an example, a skill, an error message, or CLI output. `CONTRIBUTING.md` has the page structure, the comark-ui blocks, the snippet check, and the agent-only blocks. This file has the judgment.

## Two readers, one page

Every page serves a beginner who has never used ViteHub and a coding Agent that copies the code. A page that works for the beginner usually works for the Agent. Add an agent-only block only when a real Agent run fails without it.

## Less text

Too much text is the most common problem in ViteHub docs.

- Cut until the page only has what the reader needs to succeed. Move edge cases to a collapsible block or the reference page.
- Lead with a working example. Show the Nuxt version first, with tabs for Vite and Nitro when they differ.
- After a code block, explain only the lines that the reader must understand.
- One page, one task. When a page grows long, split it.

## Plain words

- Write in ASD-STE100 English. When in doubt, write so that a 15 year old understands it.
- Explain each term the first time, in one plain sentence. Do not use internal words, such as "seam", "projection", or "materialize", where a plain word works.
- Do not explain tools the reader already knows, such as ESM or pnpm, unless the step fails without it.
- Do not overclaim. Say what the feature does, and say what it does not do.
- For tone and length, copy good docs: Nuxt, evlog, and executor.sh.

## Real examples

- Examples come from real use cases. Use a realistic app, real names, and real data. Do not use `foo`, `bar`, or a todo list when a real case exists.
- Every code block runs when an Agent copies it. Docs never show type hacks such as `as never` or `as any`.
- Show the real output of each command, copied from a real run.

## Docs ship with the code

- Update docs and the package README in the same pull request as the behavior, written as if the change were already released.
- For a new primitive or a large feature, write the docs pages first. They show whether the API is easy to explain. If it is hard to explain, change the API.
- An error message is docs: each code names the problem, the real cause, and the fix.

## Skills

Skills are minimal but give an Agent enough to succeed. Generated skill references come from docs blocks, so edit the block, not the generated file. When you change how docs or skills are served, start a fresh Agent session and check that it finds them.

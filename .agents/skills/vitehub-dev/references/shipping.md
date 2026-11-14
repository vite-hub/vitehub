# Ship a change

Read this when you open, update, or review a pull request, or when a consumer needs a fix. `CONTRIBUTING.md` has the commands and the pull request rules. This file has the judgment.

## Prove it end to end

- Reproduce first. A bug fix starts with a test or script that fails on `main`.
- Test in a real project, not only with mocks. For a framework change, create a Nuxt 5 app outside the repository, install the branch build from pkg.pr.new, and run it in dev and in production.
- Test every host, provider, and configuration form that the change affects.
- For speed, size, or startup claims, measure on the base and on the branch with the same build. Put both numbers in the pull request.

## Fix it where it belongs

When a consumer (a template, an app, a first-party project) hits a ViteHub gap:

1. Prove the smallest fix in the consumer with `pnpm patch`, or with a pkg.pr.new build of the branch.
2. Open the fix in ViteHub with focused tests.
3. Update the consumer to the fixed version and remove the patch.

The fix is done when the consumer works without the patch. Report every paper cut you hit in ViteHub along the way, and give each one a pull request.

## Pull request shape

- One concern per pull request. Independent bugs get independent pull requests. A fix to CI gets its own pull request.
- Related pull requests form a stack. Check that the stack works when all of it merges.
- Add the tests that prove the behavior, not every test you can think of. Keep end-to-end tests fast and few.
- Start the body with the problem, then the fix in plain words, then what you verified and what you did not. A public API change shows the before and after code at the top.

## Review

- Challenge a large plan or a new public API before you build it. Ask a second reviewer whether a smaller design solves the same problem.
- In review, report real defects and simpler designs. When fixes do not converge after a few rounds, propose a simpler contract instead of more cases.

## Keep work moving

- Do not close or park a good pull request. Close one only when it will not merge, and say why.
- Review and merge a new contributor's pull requests quickly, so they keep contributing. When you squash one, credit them as co-author.
- Do not open issues or pull requests on third-party repositories unless you are asked. Draft the text and hand it over.
- Keep durable research in the pull request or issue that it supports, so later contributors find it.

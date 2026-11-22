# @vite-hub/forge decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Resolve the App bot's commit email from its public user ID

`appIdentity` in `packages/forge/src/github-app.ts`.

**Context:** The App JWT works on `/app` endpoints, not the public bot user endpoint. GitHub links the commit to the bot using its numeric user ID in the noreply address.

**Decision:** Read the public bot user without the App JWT. If the ID is not available, keep the login-only noreply address.

**Consequences:** An unavailable user lookup does not prevent a commit, but GitHub may not attribute it to the bot.

## Forge GitHub behavior

`conditional fetch`, `archive download`, `forgeCommitFiles`, `tokenUsername`, `pendingMerge`, `appProvider`, `installationTokens`, `ForgeApiError exports`, `forgeErrorStatus`, `onwarn` in `packages/forge/src/conditional.ts`, `packages/forge/src/gaps/archive.ts`, `packages/forge/src/gaps/commit-files.ts`, `packages/forge/src/gaps/git-credentials.ts`, `packages/forge/src/gaps/merge.ts`, `packages/forge/src/github-app.ts`, `packages/forge/src/index.ts`, `packages/forge/src/provider.ts`, `packages/forge/vite.config.ts`.

**Context:** GitHub rate limits, API limits, auth rules, and forges bundled into the package.

**Decision:** ETag cache only with credentials; codeload for anonymous archives; Git database for empty or authored commits; fixed token user names; wait only for the same merge; one provider per installation with WeakMap tokens; re-export forges error classes; fail the build on unresolved imports.

**Consequences:** Each one guards quota, correctness, or instanceof across copies.

## Read GitHub branch rules outside forges

`GitHubBranchRuleDetails`, `githubBranchRuleDetails` and `forgeBranchRules` in `packages/forge/src/gaps/branch-rules.ts`.

**Context:** forges `BranchRules` has no required workflows, ruleset merge methods or classic protection source ([danielroe/forges#294](https://github.com/danielroe/forges/issues/294)). `repos.branchRules()` rejects with 403 when GitHub refuses rulesets to a private repository on a plan without them ([danielroe/forges#293](https://github.com/danielroe/forges/issues/293)). Both issues are open, and forges 0.4.0 has neither.

**Decision:** Read the missing fields from the raw GitHub response, and answer that 403 with no rules only when the branch summary reports the branch unprotected.

**Consequences:** When forges ships both fixes, bump forges and delete the gap module. Any other 403 must keep rejecting, so a missing permission never reads as no rules.

## Merge with bypass_rules through GitHub's merge endpoint

`forgeMerge` with `bypassRules` in `packages/forge/src/gaps/merge.ts`.

**Context:** forges `threads.merge()` cannot bypass branch rules, and GitHub's asynchronous merge takes `bypass_rules` ([danielroe/forges#297](https://github.com/danielroe/forges/issues/297), open, not in forges 0.4.0).

**Decision:** Without `bypassRules`, call `threads.merge()`. With it, call GitHub's merge endpoint directly and wait for the pending merge of the same head.

**Consequences:** When forges ships #297, bump forges and pass the option through `threads.merge()`.

## Change a pull request's base with a direct PATCH

`retargetPullRequest` in `packages/forge/src/gaps/retarget.ts`.

**Context:** forges `threads.update()` cannot change the base branch of a pull request ([danielroe/forges#190](https://github.com/danielroe/forges/issues/190), open, not in forges 0.4.0).

**Decision:** PATCH the GitHub pull request's `base` directly.

**Consequences:** When forges ships #190, bump forges and delete `retargetPullRequest`.

## Mint installation tokens with a raw request

`installationToken` in `githubAppCredentials` in `packages/forge/src/github-app.ts`.

**Context:** forges 0.3.1 `installations.token()` takes a signal ([danielroe/forges#195](https://github.com/danielroe/forges/pull/195)), but it reuses its cached token until 60 s before expiry, with no minimum lifetime, and its abort only stops the caller's wait, not the shared request. A caller that hands the token to a long job needs a token that outlives the job. Not reported upstream yet.

**Decision:** POST `/app/installations/{id}/access_tokens` with the caller's signal, and keep the token per provider until it has less than `minLifetime` (at least 60 s) left.

**Consequences:** When forges takes a minimum lifetime and aborts the shared request, use `installations.token()` and delete `installationTokens`.

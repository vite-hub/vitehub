import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('preserves open child pull requests before merging a stacked base', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')
  const preserveChildren = prompt.indexOf('Retarget every open child pull request to this pull request\'s base branch')
  const merge = prompt.indexOf('When the gate holds, squash through GitHub\'s merge API')

  assert.notEqual(preserveChildren, -1)
  assert.notEqual(merge, -1)
  assert.ok(preserveChildren < merge)
})

test('keeps a stack-locked child open without blocking its parent merge', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /refuses the retarget because the child is part of a stack/)
  assert.match(prompt, /keep the child on the source branch and retain that branch after merging/)
  assert.match(prompt, /Do not block the parent for that stack restriction alone/)
  assert.match(prompt, /delete the source branch only when no open child still uses it as a base/i)
})

test('ends a repair pass after one commit, push, and review request', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /for one pass, then stop/)
  assert.match(prompt, /at most one new commit/)
  assert.match(prompt, /push once/)
  assert.match(prompt, /request at most one `@codex review`/)
  assert.match(prompt, /Stop after the review request while real exact-head checks or review are pending/)
  assert.doesNotMatch(prompt, /repeat until the merge gate holds/)
})

test('repairs every exact-head actionable item before yielding', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /exact-head CI\/check failures and actionable bot review comments or threads/)
  assert.match(prompt, /Repair every current actionable CI\/CD failure, review finding or unresolved thread, merge conflict/)
  assert.match(prompt, /Fix all actionable items in this bounded pass/)
  assert.match(prompt, /Resolve conflicts and metadata only when they actually block this pull request/)
})

test('diagnoses failed checks without retrying unchanged-head workflows', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /Treat a failed check as evidence to diagnose and fix/)
  assert.match(prompt, /Never rerun, retry, or retrigger a remote CI\/check workflow on an unchanged head/)
  assert.match(prompt, /let the single repair push create the next check run/)
  assert.match(prompt, /required-check failure is external infrastructure and no repository change can fix it/)
  assert.match(prompt, /record the concrete external blocker and stop unchanged/)
})

test('parks CI failures inherited unchanged from the exact base head', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /appears unrelated to the pull request diff/)
  assert.match(prompt, /latest completed CI run for the exact current head of the pull request's base branch/)
  assert.match(prompt, /do not copy a base-branch fix into this pull request or push a repair/)
  assert.match(prompt, /Report the base regression, park unchanged, and resume after the base branch advances/)
  assert.match(prompt, /exact-base CI passes the matching check or shows a different failure, continue diagnosing and repair it as branch-introduced/)
})

test('does not let unavailable optional check failures create merge blockers', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /Diagnose a visible optional failure once/)
  assert.match(prompt, /report the concrete diagnosis without creating or retaining a blocker/)
  assert.match(prompt, /Remove any generated blocker based only on that optional failure and continue to the merge gate in the same pass/)
  assert.match(prompt, /Optional pending, stuck, or externally failed checks do not block this gate when they expose no repository defect/)
})

test('uses Pullfrog exact-head evidence without blocking on terminal service failure', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /Pullfrog is review evidence, not an optional check/)
  assert.match(prompt, /successful Pullfrog run must submit a review for the expected head/)
  assert.match(prompt, /successful exact-head run finishes without a review/)
  assert.match(prompt, /prior `@pullfrog` review request naming the expected head/)
  assert.match(prompt, /post exactly one `@pullfrog Please review this PR at exact head <expected-head> and submit a GitHub review\.` comment/)
  assert.match(prompt, /stop without repeating it/)
  assert.match(prompt, /review for another head blocks the merge/)
  assert.match(prompt, /terminal Pullfrog quota, error, or unavailable result is non-blocking/)
  assert.match(prompt, /Existing actionable Pullfrog findings remain feedback and must be repaired/)
})

test('does not request duplicate reviews for the same head', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /Do not request another review when that exact head already has a review request/)
})

test('keeps OTLP observability terminal-only so live exporter failure cannot delay provider cleanup', async () => {
  const agent = await readFile(new URL('../server/agents/babysitter/agent.ts', import.meta.url), 'utf8')

  assert.match(agent, /endpoint: consoleClient\.endpoint\('\/api\/otlp\/v1\/traces'\)/)
  assert.match(agent, /otlp\(\{[\s\S]*content: \{ inputs: true, instructions: true, outputs: true \}/)
  assert.doesNotMatch(agent, /live: true/)
})

test('uses focused validation without routine builds or duplicate review gates', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /Validation is limited to focused affected tests, lint or doctor, and typecheck when available/)
  assert.match(prompt, /Diagnose remote build failures from their logs, validate the repair with that limited set/)
  assert.match(prompt, /let remote CI execute the build/)
  assert.match(prompt, /inspect the relevant package scripts and task definitions for indirect build steps/)
  assert.match(prompt, /install dependencies with lifecycle scripts disabled/)
  assert.match(prompt, /Invoke the underlying test, lint, doctor, or typecheck runner directly when a wrapper includes a build/)
  assert.match(prompt, /never choose a wrapper whose expansion runs a build/)
  assert.match(prompt, /Do not run a local build command, package build script, task-runner build target, consumer build, production build, broad validation matrix, or duplicate check/)
  assert.doesNotMatch(prompt, /local build only when/)
  assert.doesNotMatch(prompt, /pnpm .*build/)
  assert.match(prompt, /Use validate-direction only when an explicit current maintainer instruction or actionable bot finding raises a direction question/)
  assert.match(prompt, /Do not run code-review as a routine gate/)
  assert.doesNotMatch(prompt, /Run focused tests and code-review on the finished diff/)
})

test('yields pending checks and reviews to the next schedule', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /checks or reviews are pending/)
  assert.match(prompt, /stop unchanged/)
  assert.match(prompt, /GitHub state change wakes the next pass/)
})

test('merges on repository gates without a Codex fallback review', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /On a later pass, merge immediately when the exact-head merge gate holds/)
  assert.match(prompt, /passing required checks, no merge conflict, and no actionable or unresolved feedback/)
  assert.match(prompt, /Optional pending, stuck, or externally failed checks do not block this gate/)
  assert.match(prompt, /Do not wait for an optional check/)
  assert.match(prompt, /Codex `eyes` reaction without a later terminal result means a requested review is pending/)
  assert.match(prompt, /Codex quota, error, or unavailable result is non-blocking/)
  assert.match(prompt, /do not launch a fallback review/)
  assert.match(prompt, /Existing actionable Codex findings remain feedback and must be repaired/)
  assert.doesNotMatch(prompt, /positive exact-head Codex or read-only fallback review/)
  assert.doesNotMatch(prompt, /permits one read-only fallback review/)
})

test('revalidates generated directions and blockers against current authority and evidence', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /newer explicit maintainer instruction supersedes an older direction verdict/i)
  assert.match(prompt, /Use validate-direction only when an explicit current maintainer instruction or actionable bot finding raises a direction question/)
  assert.match(prompt, /generated blocker.*historical claim/i)
  assert.match(prompt, /reproduce its condition in the current checkout or live GitHub state/i)
  assert.match(prompt, /must not stop unchanged solely because a stale generated marker/i)
  assert.match(prompt, /keep a blocker only while its external condition still reproduces/i)
})

test('leaves lifecycle delivery to the scheduler and returns a concise final result', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /scheduler owns the pull request's working-status comment/i)
  assert.match(prompt, /posts this invocation's final response into it/i)
  assert.match(prompt, /<!-- babysitter:disposition:park -->/)
  assert.match(prompt, /<!-- babysitter:disposition:retry -->/)
  assert.match(prompt, /failed check remains unfixed/)
  assert.match(prompt, /under 80 words/i)
  assert.match(prompt, /surrounding comment already identifies the repository, pull request, and session/i)
  assert.match(prompt, /omit process narration/i)
})

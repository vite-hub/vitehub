---
name: delete-comment
description: Delete code comments in a ViteHub package or folder and lower the comment ratchet. Use for /delete-comment, when the `vitehub/no-comments` lint fails, or when a change leaves a file with comments.
---

# Delete comments

The `vitehub/no-comments` lint rule (`scripts/lint/comments.mjs`) bans every comment that no tool reads. `adr/repo.md` lists the comments it keeps and why. `scripts/lint/comment-baseline/<area>.json` holds the per-file count that existed when the rule landed. A file can go below its count, never above it.

The scope is the paths that the caller names. Otherwise it is the files that your branch changes.

## Steps

1. **List.** Run `node scripts/lint/delete-comments.mjs --list <paths>`. It prints `file:line: comment` for each banned comment. Done when you have the full list.
2. **Classify.** Read each comment next to its code, and put it in one class:
   - _Tautology_: it repeats what the code already says.
   - _Stale_: it names code, behavior, or history that is no longer true.
   - _Excuse_: it lets a workaround stay, such as "for now", "hack", "TODO", "until X lands", "we cannot because", an empty `catch` that hides errors, or a defensive branch for a state that cannot happen.
   - _Decision record_: it holds a non-obvious decision that the code cannot show, and that a future change would break without knowing it. Check the claim against the code before you trust it. A false claim is Stale.

   When you find a comment that a tool or test reads, keep it and add an exemption to `scripts/lint/comments.mjs` and `adr/repo.md`. Done when every listed comment has one class.
3. **Record.**
   - For each Decision record, add an entry to the area's decision log, `adr/<package>.md` or `adr/repo.md` (see `adr/README.md`). One entry holds one decision. Merge comments that record the same decision, and extend an entry that already holds it.
   - For each Excuse, file one issue on `vite-hub/vitehub` per package with a checklist: the file and symbol, the deleted comment, the workaround it excused, and the fix you propose. Use the title `cleanup(<package>): workarounds found by /delete-comment`. Link the base commit, since the comments are gone on the branch.
4. **Delete.** Run `node scripts/lint/delete-comments.mjs <paths>`. It deletes every banned comment in the paths, whatever its class. Change no code. When a deletion makes code unclear, rename the symbol in a separate pull request.
5. **Ratchet.** Run `node scripts/lint/update-comment-baseline.mjs`, then `corepack pnpm exec vp lint`. Done when lint passes and the baseline files show only lower counts or deleted entries.
6. **Prove.** Run the `test` and `typecheck` scripts of each package you changed, through `heavy`. A test that reads source text can fail when a comment goes. Fix the test, not the comment.

Report the deleted count per class, the decision log entries, the issues, and the checks that you ran.

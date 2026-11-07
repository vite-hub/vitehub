---
title: Code Review
description: "Review an Agent's changes with a file tree, a patch diff for the selected file, and the verification trace."
navigation.order: 12
navigation.group: Blocks
icon: i-ph-git-diff-light
---

This block combines [`FileTree`](/docs/ui/file-tree), [`PatchDiff`](/docs/ui/diff), and [`TraceRun`](/docs/ui/trace). Select a changed file to see its diff. The trace below shows the verification run. The patches and run are fake.

::component-preview{name="CodeReviewBlock" flush reset}
::

## Wire the panes

- Create the tree model with `useFileTree()` and read the selection with `useFileTreeSelection()`.
- Mark changed files with the `gitStatus` option.
- Key the diff by the selected path, so Pierre renders a new view per file.

## Load real data

Read patches from the Agent's Workspace changes or Git. Get the trace run from `deriveTraceRuns()` in `@vite-hub/runtime`.

## Components used

- [File tree](/docs/ui/file-tree)
- [Diff](/docs/ui/diff)
- [Trace](/docs/ui/trace)

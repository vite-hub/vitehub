---
title: Code Review
description: "Review an Agent's changes with a file tree, a patch diff for the selected file, and the verification trace."
navigation.order: 52
navigation.group: Blocks
icon: i-ph-git-diff-light
---

This block combines [`AgentFileTree`](/docs/ui/file-tree), [`AgentPatchDiff`](/docs/ui/diff), and [`AgentTrace`](/docs/ui/trace). Select a changed file in the tree to see its diff. The trace under the diff shows the verification run. The patches and the run are synthetic.

::component-preview{name="CodeReviewBlock" flush reset}
::

## Wire the panes

- Create the tree model with `useAgentFileTree()` and read the selection with `useAgentFileTreeSelection()`.
- Mark changed files with the `gitStatus` option.
- Key the diff by the selected path, so Pierre renders a new view for each file.

## Load real data

Read patches from the Agent's change activities, for example with `invocationActivities(invocation)`, or from Git. Derive the trace run with `deriveTraceRuns()` from `@vite-hub/runtime`.

## Components used

- [File tree](/docs/ui/file-tree)
- [Diff](/docs/ui/diff)
- [Trace](/docs/ui/trace)

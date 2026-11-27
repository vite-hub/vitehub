---
title: Check images in CI
description: Fail a pull request that adds an image over the size limit, and post the size report as a comment.
navigation.order: 5
navigation.group: Operate
icon: i-lucide-shield-check
---

`lumen check` reads every image in a folder and compares it with a limit. It changes no file, so it is safe to run in CI.

```yaml [.github/workflows/images.yml]
name: Images
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec lumen check ./public --max-size 400kb
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every image is under the limit. |
| `1` | At least one image is over the limit. The report names each one. |
| `2` | Lumen could not read an image. |

The [exit codes reference](/docs/reference/exit-codes) lists every code.

::agent-only
When `lumen check` fails in CI, run `lumen compress <folder>` locally on the files that the report names, and commit the result. Do not raise `--max-size` to make the check pass unless the user asks for it.
::

## Post the report on the pull request

`--format markdown` prints the report as a Markdown table. Save it to a file and post it with your CI tool, for example with `gh pr comment --body-file report.md`.

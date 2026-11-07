---
title: Image budgets in CI, a field guide
description: Pick a size limit that your team keeps, fail the pull request that breaks it, and fix it in one command.
date: 2026-05-12
authors: [tomas]
tags: [guide, ci]
cover:
  pathname: illustrations/guides-light.svg
  contentType: image/svg+xml
---

An image budget is a size limit for each image, checked on every pull request. It is the cheapest performance rule that a team can keep, because the fix is one command. This is how we set one up with teams that use Lumen.

## Pick the limit from your pages

Do not start from a round number. Run `lumen check` with a high limit and read the report:

```bash [Terminal]
lumen check ./public --max-size 2mb --format json > sizes.json
```

Sort the files by size and look at the largest ten. Most teams find that a limit near the 90th percentile, often 300 to 500 KB, fails only the files that nobody compressed.

## Fail the pull request, not the build

Run the check on pull requests only, so a new limit does not block a deploy. Put the limit in `lumen.config.json` as `maxSize`, so the check in CI and the check on a laptop agree.

## Make the fix obvious

When the check fails, the report names each file and its size. The fix is `lumen compress` on those files. Say so in the CI step name, such as "Images over 400 KB: run lumen compress", so a contributor does not need to read docs to fix it.

The [CI guide](/docs/guides/ci) has a complete GitHub Actions workflow.

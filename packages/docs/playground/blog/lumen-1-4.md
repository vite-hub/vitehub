---
title: "Lumen 1.4: compare before you commit"
description: A local page that shows each original beside its result, and reports that you can paste into a pull request.
date: 2026-10-14
authors: [ada, priya]
tags: [release]
cover:
  pathname: illustrations/hero-light.svg
  contentType: image/svg+xml
---

Compression is a trade. Every byte you remove is a small risk to the picture, and until now Lumen asked you to trust a quality number. Lumen 1.4 lets you look first.

## See every result

`lumen compare` reads a folder and opens a local page. Each row shows the original and the result side by side, with a slider between them and the bytes saved. It changes no file, so you can run it before `lumen compress` writes anything.

```bash [Terminal]
lumen compare ./public --quality 70
```

Drag the slider on the photos with fine detail first: hair, foliage, and text on signs show artifacts before flat areas do. When a result looks wrong, add the file to `skip` or raise `quality` for that folder.

## Reports for pull requests

`--format markdown` prints the report as a Markdown table. In CI, save it to a file and post it as a comment, so reviewers see what an image change costs without opening the files.

```bash [Terminal]
lumen check ./public --format markdown > report.md
gh pr comment --body-file report.md
```

## Upgrade

```bash [Terminal]
pnpm add -g lumen-cli@1.4
```

There are no breaking changes. The full list is in the [changelog](/changelog/1-4-0).

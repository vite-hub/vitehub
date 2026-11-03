---
title: Run Lumen in CI
description: Fail a build when images are too large.
navigation.order: 2
---

# Run Lumen in CI

`lumen check` exits with code 1 when an image is larger than `--max-size`:

```sh
lumen check ./public --max-size 300kb
```

Use it as a step after the build. It does not change files.

---
title: Install Lumen
description: Install the lumen binary with npm or pnpm.
navigation.order: 1
---

# Install Lumen

Install the binary globally:

```sh
pnpm add -g lumen-cli
```

Check the version:

```sh
lumen --version
```

Lumen does not support Node.js 22 or older. The install fails with `LUMEN_E_NODE` on those versions.

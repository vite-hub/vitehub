---
title: Install Lumen
description: Install the lumen binary with pnpm, npm, or Homebrew, and check that it runs.
navigation.order: 1
icon: i-lucide-download
---

Lumen is one binary. Install it globally, or add it to a project as a development dependency.

::tabs
  :::tabs-item{label="pnpm" icon="i-simple-icons-pnpm"}
    ```bash [Terminal]
    pnpm add -g lumen-cli
    ```
  :::

  :::tabs-item{label="npm" icon="i-simple-icons-npm"}
    ```bash [Terminal]
    npm install -g lumen-cli
    ```
  :::

  :::tabs-item{label="Homebrew" icon="i-simple-icons-homebrew"}
    ```bash [Terminal]
    brew install lumen
    ```
  :::
::

::agent-only
In a project, install Lumen as a development dependency with `pnpm add -D lumen-cli` and run it with `pnpm exec lumen`. Do not install it globally in CI. Run `lumen --version` to check the install. It prints a version such as `1.4.0`.
::

## Check the version

```bash [Terminal]
lumen --version
```

The command prints the version, such as `1.4.0`.

::note
Lumen 1 needs Node.js 24 or newer. On an older version, `lumen` stops with exit code `3` and prints the version that it found.
::

## Update Lumen

Run the install command again. Lumen reads its config file in the same format in every 1.x release, so an update does not change your settings.

Next, [compress your first folder](/docs/getting-started/first-folder).

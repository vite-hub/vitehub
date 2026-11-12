---
title: Bundle checks
description: The problems that vitehub bundle proves from a report, its exit codes for CI, and how a ViteHub feature declares a startup rule.
navigation.title: Checks
navigation.order: 4
icon: i-lucide-shield-check
---

`vitehub bundle` ends with the problems that the report proves. `--json` gives them in `findings`. Each finding has a `code`, a `severity`, a `why`, a `fix`, a `docs` link, the bytes, and the import chain from the server entry.

| Code | Severity | Meaning |
| --- | --- | --- |
| [`BUNDLE_STARTUP_UNUSED`](/docs/reference/errors-diagnostics#bundle_startup_unused) | Warning | A package loads at server startup, and a feature of this build never runs it there. |
| [`BUNDLE_HOST_SIZE_LIMIT`](/docs/reference/errors-diagnostics#bundle_host_size_limit) | Error | The server JavaScript is over the host limit. Cloudflare accepts a Worker up to 64 MiB before compression. |

## Run it in CI

An error makes the command exit with 1. A warning keeps exit code 0. Run the command after the build:

```bash [Terminal]
pnpm build
pnpm vitehub bundle
```

The report counts only JavaScript. The host also counts other files, such as WebAssembly, so a build under the limit can still fail to deploy.

## Startup rules

A startup rule says that a package is not needed at server startup for this build. A feature declares it from its resolved configuration, not from the package name. For example, the Database declares the libSQL client on a Cloudflare build where every Database is D1 or Postgres.

A feature adds its rules in the Nitro hook `vitehub:bundle:rules`:

```ts [modules/database.ts] fragment
nitro.hooks.hook("vitehub:bundle:rules", (rules) => {
  rules.push({ owner: "@vite-hub/database", packages: ["@libsql/client"], why: "...", fix: "..." })
})
```

A rule applies only when its packages are imported by its `owner` or by each other. An import from app code or from another package suppresses the finding, because the feature cannot prove what that code needs.

The [errors and diagnostics reference](/docs/reference/errors-diagnostics#bundle-checks) explains how to fix each code.

---
description: "Fix VITE_HUB_PACKAGE_VERSION_UNSUPPORTED: install every @vite-hub package from the release of vite-hub, also in pnpm overrides."
seo.title: "VITE_HUB_PACKAGE_VERSION_UNSUPPORTED in ViteHub"
---

The build stops with `VITE_HUB_PACKAGE_VERSION_UNSUPPORTED` when an installed `@vite-hub/*` package does not come from the release of the installed `vite-hub`. The message names each package, its installed version, and the versions that `vite-hub` supports:

```text [output/unsupported-vitehub-package.txt]
[VITE_HUB_PACKAGE_VERSION_UNSUPPORTED] @vite-hub/agent 0.0.0-preview-8724a59 is installed, but vite-hub 0.0.0-preview-391b51f supports @vite-hub/agent@0.1.0 || 0.0.0-preview-391b51f. ViteHub packages of another release do not work with this vite-hub. The app can build and then fail at runtime, or run the code of the other release.
├▶ fix: Install the ViteHub packages of the same release as vite-hub: `pnpm add https://pkg.pr.new/vite-hub/vitehub/@vite-hub/agent@391b51fd4b56d75242fb767bdd2b001808dba29f`. When pnpm `overrides`, `resolutions`, or the lockfile pin a @vite-hub package, change them to the same release too, then install again.
╰▶ see: https://vitehub.dev/docs/development/diagnostics/vite_hub_package_version_unsupported
```

## Why it happens

`vite-hub` and the `@vite-hub/*` packages share internal contracts that can change in any commit. `vite-hub` lists the versions of each package that it supports. A package of another release can build and then fail at runtime, or run the old code of a feature without an error.

The usual causes:

- An upgrade changed `vite-hub` in `package.json`, but not the `@vite-hub/*` packages.
- pnpm `overrides` in `pnpm-workspace.yaml` or `package.json`, or `resolutions`, still pin the packages to the earlier release. pnpm applies them, so `pnpm install --frozen-lockfile` passes and installs the earlier release.

Other packages that `vite-hub` supports, such as `drizzle-orm`, only print a warning when their version is out of range.

## Fix it

Run the `pnpm add` command of the message. When `overrides` pin the packages, change them to the same release:

```diff [pnpm-workspace.yaml]
 overrides:
-  "@vite-hub/agent": https://pkg.pr.new/vite-hub/vitehub/@vite-hub/agent@8724a59e6864f59c269361ad7325d52cf63f4106
+  "@vite-hub/agent": https://pkg.pr.new/vite-hub/vitehub/@vite-hub/agent@391b51fd4b56d75242fb767bdd2b001808dba29f
```

Then run `pnpm install` and commit the lockfile.

## Check the fix

Run the build again. It does not report `VITE_HUB_PACKAGE_VERSION_UNSUPPORTED`.

## Related

- [Add feature packages](/docs/getting-started/installation#add-feature-packages)

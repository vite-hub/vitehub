---
title: Bundle reference
description: The vitehub bundle commands and flags, the files the build writes, the bundle option, and the exports of @vite-hub/bundle.
navigation.title: Reference
navigation.order: 5
icon: i-lucide-book-open
---

## Option

| Placement | Value | Effect |
| --- | --- | --- |
| `vitehub({ bundle })` in `vite.config.ts` | `boolean` | `true` writes a report of each production build. Omission or `false` writes nothing. |
| `vitehub: { bundle }` in `nuxt.config.ts` | `boolean` | The same, for a Nuxt 5 app with `vite-hub/nuxt`. |

## Commands

The commands read the report of the last production build. They need no dev server.

| Command | Prints |
| --- | --- |
| `vitehub bundle` | The client and server size, the startup size, the largest groups and routes, and the checks. |
| `vitehub bundle --json` | The full report as JSON, with `findings`. |
| `vitehub bundle --against <report>` | The change from a saved report: side and startup deltas, and the groups that changed. |
| `vitehub bundle --against <report> --json` | The same change as JSON. |
| `vitehub bundle why <package\|file\|group>` | The shortest import chain from an entry to the target. |
| `vitehub bundle why </route>` | What a first visit to the page route loads. Nuxt apps only. |
| `vitehub bundle why <target> --json` | The same as JSON. |

### Exit codes

| Code | When |
| --- | --- |
| `0` | The report has no error finding. A warning keeps `0`. |
| `1` | A check found an error, there is no report, the `--against` path has no report, an argument is unknown, or `why` gets a route while route estimates are unavailable. |

Without a report, the command prints: `No bundle report in .vitehub/bundle/. Set bundle: true in vitehub() (vite.config.ts) or in vitehub (nuxt.config.ts), then run a production build.`

## Files

| File | Content |
| --- | --- |
| `.vitehub/bundle/<environment>.json` | The report of one build environment, such as `client`, `ssr`, or `nitro`. A new build removes the files of older builds. |
| `.vitehub/bundle-root.json` | Where the report is. The build writes it in its working directory and beside the Vite config. |

## Read the report in code

`vite-hub/bundle` re-exports `@vite-hub/bundle`:

```ts [scripts/bundle-check.ts]
import { compareBundleReports, explainBundleRouteTarget, explainBundleTarget, readBundleReport, readSavedBundleReport } from "vite-hub/bundle"

const report = readBundleReport(process.cwd())
const why = explainBundleTarget(process.cwd(), "zod")
const page = explainBundleRouteTarget(process.cwd(), "/docs/kv")
const diff = compareBundleReports(readSavedBundleReport(".vitehub/bundle-before.json")!, report!)
```

| Export | Returns |
| --- | --- |
| `readBundleReport(root)` | The report of the last build in `root`, the same object as `vitehub bundle --json`, or `undefined`. |
| `explainBundleTarget(root, target)` | The import chains to a package, a file, or a group. |
| `explainBundleRouteTarget(root, path)` | What a first visit to the route that renders `path` loads, or `undefined`. |
| `readSavedBundleReport(path)` | A report from `vitehub bundle --json`, a copy of `.vitehub/bundle/`, or a checkout root. |
| `compareBundleReports(before, after)` | The change between two reports. |
| `createBundleReport(reports)`, `explainBundle(reports, target)`, `explainBundleRoute(reports, target)` | The same results from environment reports that you read yourself with `readEnvironmentReports(root)`. |
| `moduleGroup(id)` | The `{ name, kind }` group of a module id. |
| `bundleReportDir` | `".vitehub/bundle"`. |

The report has `schemaVersion: 1`, the `build` ID, the Nitro preset as `host`, the `client` and `server` sides, and `findings`.

## `@vite-hub/bundle/vite`

`hubBundle(options?)` is the Vite plugin that `vitehub({ bundle: true })` adds. Pass `buildId` when a tool runs build phases in separate processes, so that every phase writes to the same report. The plugin also has a Nitro module for builds where Nitro bundles on its own.

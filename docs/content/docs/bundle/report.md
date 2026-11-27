---
title: Read the bundle report
description: What the client, server, startup, group, route, and comparison numbers count, and how the plugin measures a Vite or Nuxt build.
navigation.title: Read the report
navigation.order: 3
icon: i-lucide-chart-bar
---

## Client and server

Each side has the bytes and gzip bytes of the JavaScript that the build wrote, and of the files that load at startup. Startup files are the entries and every file that they import statically.

- On the server, startup code runs before the first request. Less startup code gives a faster cold start.
- Client startup combines all page entries and counts shared files once. A single page can load less. Use [routes](#routes) for one page.

The report joins the build environments. In Nuxt 5, Nitro bundles the SSR output, so the server side shows the SSR modules inside it instead of one large file.

## Groups

Each module counts toward one group:

| Kind | Examples |
| --- | --- |
| `vitehub` | `@vite-hub/agent`, `vite-hub/console` |
| `framework` | `nitro`, `h3`, `vue` |
| `dependency` | Any other package |
| `app` | An app folder, such as `server/api` |
| `generated` | `.vitehub`, `#nitro/virtual` |

A module gets its share of the bytes of the file that it is in, so the groups add up to the file sizes. Each group also has its startup bytes: the bytes in files that load at startup.

## Why

`vitehub bundle why <target>` gives the shortest import chain from an entry to a package, a file, or a group. When no chain exists, a plugin or the bundler added the module.

## Routes

In a Nuxt app, the client report lists what the browser loads on a first visit to each page route:

- the startup files,
- the files of the route's layout and pages, with every file that they import statically,
- their CSS.

Files that the page loads later with `import()` do not count. `why /docs/kv` finds the route that renders the path and lists its files and the largest modules that it adds.

`vite-hub/nuxt` reads the pages and layouts that Nuxt resolves and passes them to the plugin. A layout is known when `definePageMeta` sets a static `layout`. Otherwise the route uses `default`. Layout files count only when the startup or page files also load Nuxt's `NuxtLayout` component. If Nuxt does not expose the file of that component, layout files are left out.

Static route aliases share the files and bytes of the canonical route. Lookup uses Vue Router's matcher and Nuxt's `router.options.sensitive` and `strict` settings. Nuxt 5 matches case-sensitively by default.

### When routes are unavailable

The report has no route estimates when:

- the app has an `app/router.options.ts` file, also from a layer or a module, because it can replace routes or matching settings at runtime. This applies also when the file changes only other settings.
- a page has a redirect, because the destination can change before a page renders.

The CLI says why, and `client.routesUnavailable` in `--json` holds the reason. Totals and `why` for modules still work. Runtime changes to the layout, and a `NuxtLayout` that renders only under a condition, are not measured.

## Against

`--against <report>` compares the last build with a saved report. It gives the bytes, gzip bytes, and startup bytes of each side, and the groups that grew, shrank, were added, or were removed. The saved report can be the output of `vitehub bundle --json`, a copy of `.vitehub/bundle/`, or the root of another checkout with a build.

If both reports are from the same build, the command says so. Run the production build again after the change, then compare.

## How the plugin measures

`hubBundle()` is a Vite plugin. `vitehub({ bundle: true })` adds it. In `writeBundle`, it reads the output chunks of Rolldown, the rendered length of each module, and the module graph, and writes `.vitehub/bundle/<environment>.json`. When Nitro bundles on its own, as in Nuxt 5, the Nitro module of the plugin adds the same reader to Nitro's build.

Each Vite build command starts a fresh report. All environments of one Vite builder share a build ID, and `vite-hub/nuxt` starts one session for the Vite and Nitro phases of Nuxt. A custom tool that runs build phases in separate processes must pass the same fresh `buildId` to `hubBundle({ buildId })` in every phase. Separate commands do not join reports that are left on disk.

The build also writes the location of the report to `.vitehub/bundle-root.json`, in the working directory of the build and beside the Vite config. This lets `vitehub bundle` find the report of a nested root without loading the project. Run a production build once to create this file for reports from an older version.

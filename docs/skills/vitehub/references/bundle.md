# Bundle size and startup cost

Use this when a task asks how big the app is, why the server starts slowly or hits a host size limit, why a page loads too much JavaScript, or why a package is in the output.

## Measure

1. Set `bundle: true` in `vitehub()` (`vite.config.ts`) or in `vitehub` (`nuxt.config.ts`). It is off by default.
2. Run a production build: `vite build` or `nuxt build`. Development builds are not measured.
3. Run `vitehub bundle`. It reads `.vitehub/bundle/` and needs no dev server.

`vitehub bundle` shows the client and the server separately. For each, it shows the JavaScript bytes, the gzip bytes, the startup code, and the largest groups. A group is a ViteHub package (`@vite-hub/agent`, `vite-hub/console`), a framework package, a dependency, an app folder (`server/api`), or generated code (`.vitehub`, `.nuxt`, `#nitro/virtual`). In Nuxt 5, the server part already contains the SSR build. Do not read Vite environments one by one.

- **Server startup** is the code that loads before the first request: the entry and every file that it imports statically. It decides cold start time and Worker startup limits.
- **Client startup** combines the startup code of all page entries, counting shared files once. A single page in a multi-page app can load less.

## Explain

`vitehub bundle why <package|file|group>` prints the bytes on each side, whether the target loads at startup, and the shortest import chain from the entry. Read the chain from the end: the first step that is app code or a ViteHub feature is usually the one to change. For example, change a static import to `import()` or turn the feature off.

Use `--json` on both commands when you compare numbers or write them into a report.

## Prove a change

Run the build and `vitehub bundle` before and after the change. Report both numbers for the side and the group that changed, and the import chain that you removed.

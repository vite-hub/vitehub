# @vite-hub/ui

AI interface primitives for Vue and Nuxt. The package renders AI SDK `UIMessage` values, composes Nuxt UI, and provides headless message scrolling plus ViteHub invocation, trace, diff, and file-tree views.

```bash
pnpm add @vite-hub/ui @nuxt/ui ai vue
```

```ts
export default defineNuxtConfig({
  modules: ["@vite-hub/ui/nuxt"],
});
```

For Vue with Vite, use `@vite-hub/ui/vite`, install `createViteHubUI()` on the Vue app, and import `@vite-hub/ui/styles.css`.

`AgentInvocationList` is the normalized navigation primitive for coding-agent sessions. Pass it titles, projects, statuses, and timestamps; keep routing, fetching, search, and refresh behavior in the host application. `AgentInvocation` renders the selected transcript, while `AgentInvocationInspector` provides the optional metadata panel. Set `header="false"` when the host supplies its own dashboard navbar.

Documentation: [vitehub.dev/docs/ui](https://vitehub.dev/docs/ui)

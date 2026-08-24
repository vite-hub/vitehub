# @vite-hub/ui

AI interface primitives for Vue and Nuxt. The package renders AI SDK `UIMessage` values, composes Nuxt UI, and provides headless message scrolling plus ViteHub invocation, trace, diff, and file-tree views.

```bash
pnpm add @vite-hub/ui @nuxt/ui ai tailwindcss vue
```

```ts
export default defineNuxtConfig({
  modules: ["@vite-hub/ui/nuxt"],
});
```

For Vue with Vite, use `@vite-hub/ui/vite`, install the plugins from `@nuxt/ui/vue-plugin` and `createViteHubUI()` on the Vue app, then load Tailwind, Nuxt UI, and `@vite-hub/ui/styles.css` from the application stylesheet.

`AgentInvocationList` is the normalized navigation primitive for coding-agent sessions. Pass it titles, projects, statuses, and timestamps; keep routing, fetching, search, and refresh behavior in the host application. `AgentInvocation` renders the selected transcript, while `AgentInvocationInspector` provides the optional metadata panel. Set `:header="false"` when the host supplies its own dashboard navbar.

Documentation: [vitehub.dev/docs/ui](https://vitehub.dev/docs/ui)

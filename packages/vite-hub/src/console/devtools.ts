import { mountPath } from "./nitro.ts"

const title = "ViteHub Console"
const icon = "ph:hexagon-duotone"

/** The Console entry of the Vite DevTools dock, which Devframe renders. */
export interface ConsoleDevToolsDock {
  icon: string
  id: string
  title: string
  type: "iframe"
  url: string
}

/** The Console tab of Nuxt DevTools 3 and 4. */
export interface ConsoleNuxtDevToolsTab {
  category: "modules"
  icon: string
  name: string
  title: string
  view: { src: string, type: "iframe" }
}

/**
 * The `devtools` field of a Vite plugin, as `@vitejs/devtools` reads it. Static DevTools builds skip it, because they
 * have no server to serve the Console.
 */
export interface ConsoleViteDevTools {
  capabilities: { build: false }
  setup: (context: { docks: { register: (entry: ConsoleDevToolsDock) => unknown }, viteConfig: { base: string } }) => void
}

export function consoleDevToolsDock(base: string | undefined): ConsoleDevToolsDock {
  return { icon, id: "vitehub-console", title, type: "iframe", url: mountPath(base, "/_vitehub") }
}

export function consoleNuxtDevToolsTab(base: string | undefined): ConsoleNuxtDevToolsTab {
  return { category: "modules", icon, name: "vitehub-console", title, view: { src: mountPath(base, "/_vitehub"), type: "iframe" } }
}

export const consoleViteDevTools: ConsoleViteDevTools = {
  capabilities: { build: false },
  setup(context) {
    context.docks.register(consoleDevToolsDock(context.viteConfig.base))
  },
}

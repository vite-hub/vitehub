// Nuxt provides this virtual module to applications that install the module.
// @ts-expect-error The package's standalone typecheck has no Nuxt virtual modules.
import { tryUseNuxtApp } from "#app"

import { setNuxtAppResolver } from "../vue.ts"

export default function viteHubAuthVueNuxtRuntime(): void {
  setNuxtAppResolver(() => tryUseNuxtApp() as { runWithContext<T>(run: () => T): T } | undefined)
}

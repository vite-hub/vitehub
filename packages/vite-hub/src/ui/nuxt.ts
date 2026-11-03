import { importOptionalOwner, requireOptionalOwner } from "../internal/optional-owners.ts"

import type ownerModule from "@vite-hub/ui/nuxt"

export type * from "@vite-hub/ui/nuxt"

// Nuxt loads this module before Vite runs, so it names the package to install when the app did not install it.
const viteHubUINuxtModule: typeof ownerModule = requireOptionalOwner(await importOptionalOwner("@vite-hub/ui", () => import("@vite-hub/ui/nuxt")), "ui").default

export default viteHubUINuxtModule

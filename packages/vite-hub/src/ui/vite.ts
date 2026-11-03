import { importOptionalOwner, requireOptionalOwner } from "../internal/optional-owners.ts"

import type ownerPlugin from "@vite-hub/ui/vite"

export type * from "@vite-hub/ui/vite"

// A Vite config loads this module before the ViteHub plugin runs, so it names the package to install when the app did not install it.
const viteHubUI: typeof ownerPlugin = requireOptionalOwner(await importOptionalOwner("@vite-hub/ui", () => import("@vite-hub/ui/vite")), "ui").default

export default viteHubUI

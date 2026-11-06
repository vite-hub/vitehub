declare const __VITE_HUB_VERSION__: string | undefined

/** The `vite-hub` package version. The package build and the tests set it; a source checkout without them reads `0.0.0`. */
export const version: string = typeof __VITE_HUB_VERSION__ === "string" ? __VITE_HUB_VERSION__ : "0.0.0"

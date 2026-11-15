import { defineDiagnostics } from "nostics"

// Each code identifies one ViteHub failure site. Keep published codes stable.
// The browser entries of this package do not load this catalog, so only the Vite plugin and the snapshot builder use it.
export const webContainerErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/web-container/diagnostics",
  codes: {
    // Named errors. Keep these codes in alphabetical order.
    WEB_CONTAINER_ROUTES_MISSING: {
      why: "hubWebContainer() needs at least one route, such as \"/playground/**\".",
      fix: "List the pages that boot a WebContainer in the `routes` option of `hubWebContainer`, such as `routes: [\"/playground/**\"]`.",
    },
    WEB_CONTAINER_ROUTE_INVALID: {
      why: ({ route }: { route: string }) => `hubWebContainer() route "${route}" must start with "/".`,
      fix: "Start each route in the `routes` option of `hubWebContainer` with `/`, such as `\"/playground/**\"`.",
    },
    WEB_CONTAINER_SNAPSHOT_LOCKFILE_MISMATCH: {
      why: ({ wasm }: { wasm: boolean }) => wasm
        ? "The lockfile does not match the app: its wasm builds have other versions. Pass frozenLockfile: false to update it."
        : "The lockfile does not match the app. Pass frozenLockfile: false to update it.",
      fix: "Pass `frozenLockfile: false` to `createNodeModulesSnapshot()` to update the lockfile, then save the `lockfile` of its result.",
    },
    WEB_CONTAINER_SNAPSHOT_POSIX_REQUIRED: {
      why: "createNodeModulesSnapshot requires a POSIX host (Linux, macOS, or WSL).",
      fix: "Run `createNodeModulesSnapshot()` on Linux or macOS, or in WSL on Windows.",
    },
  },
})

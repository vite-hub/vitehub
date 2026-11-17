import { defineDiagnostics } from "nostics"

// Each code identifies one ViteHub failure site. Keep published codes stable.
// The browser entries, the Vite plugin, and the snapshot builder use this catalog. nostics has no imports and loads in browsers.
export const webContainerErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/web-container/diagnostics",
  codes: {
    // Named errors. Keep these codes in alphabetical order.
    WEB_CONTAINER_CONNECT_PROVIDER_UNKNOWN: {
      why: ({ choices, name }: { choices: string, name: string }) => `Unknown connect provider "${name}". Use one of: ${choices}.`,
      fix: "Pass only the provider names that the message lists as keys of `defineConnect()`.",
    },
    WEB_CONTAINER_DEV_RUNNING: {
      why: "A dev process is already running. Stop it and await its exit before starting another.",
      fix: "Call `kill()` on the running `run(\"dev\")` result and await its `exit` before you call `run(\"dev\")` again.",
    },
    WEB_CONTAINER_FILE_PATH_INVALID: {
      why: ({ part, path, reason }: { part?: string, path: string, reason: "invalid" | "through-file" | "replaces-directory" }) => reason === "through-file"
        ? `WebContainer path ${path} goes through the file ${part}.`
        : reason === "replaces-directory" ? `WebContainer path ${path} replaces the directory ${part}.` : `Invalid WebContainer file path: ${path}`,
      fix: "Give each key of `files` a relative path to a file, such as `server/index.js`, without `..`, a leading `/`, or a path that is also a file or folder of another key.",
    },
    WEB_CONTAINER_ROUTES_MISSING: {
      why: "hubWebContainer() needs at least one route, such as \"/playground/**\".",
      fix: "List the pages that boot a WebContainer in the `routes` option of `hubWebContainer`, such as `routes: [\"/playground/**\"]`.",
    },
    WEB_CONTAINER_ROUTE_INVALID: {
      why: ({ route }: { route: string }) => `hubWebContainer() route "${route}" must start with "/".`,
      fix: "Start each route in the `routes` option of `hubWebContainer` with `/`, such as `\"/playground/**\"`.",
    },
    WEB_CONTAINER_SNAPSHOT_DAMAGED: {
      why: ({ detail, url }: { detail: string, url: string }) => `The snapshot from ${url} is damaged: ${detail}`,
      fix: "Serve the parts that `packSnapshot()` wrote, in order and unchanged, and pass the `sha256` of the same build to `fetchSnapshot()`. Build the snapshot again if the parts changed.",
    },
    WEB_CONTAINER_SNAPSHOT_LINKS_FAILED: {
      why: ({ code }: { code: number }) => `Restoring the links of the snapshot exited with code ${code}.`,
      fix: "Build the snapshot again with `createNodeModulesSnapshot()` from `@vite-hub/web-container/snapshot`, and pass it to `bootWebContainer({ snapshot })`.",
    },
    WEB_CONTAINER_SNAPSHOT_PART_BYTES_INVALID: {
      why: "partBytes must be a positive safe integer.",
      fix: "Pass a whole number of bytes above 0 as `partBytes` to `packSnapshot()`, such as `20 * 2 ** 20`, or leave it out.",
    },
    WEB_CONTAINER_SNAPSHOT_PART_FAILED: {
      why: ({ status, url }: { status: number, url: string }) => `Snapshot part ${url} returned ${status}.`,
      fix: "Check that the host serves each URL that you pass to `fetchSnapshot()`, for example the files that `packSnapshot()` wrote in the public folder. A retry helps only for a temporary server error.",
    },
    WEB_CONTAINER_SNAPSHOT_POSIX_REQUIRED: {
      why: "createNodeModulesSnapshot requires a POSIX host (Linux, macOS, or WSL).",
      fix: "Run `createNodeModulesSnapshot()` on Linux or macOS, or in WSL on Windows.",
    },
  },
})

import { defineDiagnostics } from "nostics"

import { formatBytes } from "./bytes.ts"

/** The largest Worker that Cloudflare accepts, before compression. */
// Source: https://developers.cloudflare.com/workers/platform/limits/#worker-size, "Worker size (uncompressed): 64 MiB"
// on the Free and the Paid plan. "There is no compressed size limit. Only the uncompressed bundle size counts."
export const cloudflareWorkerSizeLimit = 64 * 1024 * 1024

// Keep published codes stable. Each code has a generated docs page.
export const bundleDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    BUNDLE_STARTUP_UNUSED: {
      why: ({ packages, reason }: { packages: ReadonlyArray<{ name: string, bytes: number }>, reason: string }) =>
        `${packages.map(item => `\`${item.name}\` (${formatBytes(item.bytes)})`).join(", ")} ${packages.length === 1 ? "loads" : "load"} at server startup. ${reason}`,
      fix: ({ fix, target }: { fix: string, target: string }) => `${fix} Run \`vitehub bundle why ${target}\` for the import chain.`,
    },
    BUNDLE_HOST_SIZE_LIMIT: {
      why: ({ bytes, limit }: { bytes: number, limit: number }) =>
        `The server JavaScript is ${formatBytes(bytes)} before compression. Cloudflare rejects a Worker over ${formatBytes(limit)} (64 MiB), and the deployment also counts files other than JavaScript.`,
      fix: "Keep large data and binary files in KV, R2, D1, or static assets, not in server code. Import large packages with `import()` in the routes that use them. `vitehub bundle` lists the largest groups.",
    },
  },
})

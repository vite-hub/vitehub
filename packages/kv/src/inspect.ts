import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"
import type { ResolvedKVModuleOptions, ResolvedKVStoreConfig } from "./types.ts"

function describeDevelopment(store: ResolvedKVStoreConfig): string {
  switch (store.driver) {
    case "upstash": return "Remote. `vite dev` uses the real Upstash database, so writes change real data."
    case "cloudflare-kv-binding": return store.localBase
      ? `Local. \`vite dev\` uses the \`${store.binding}\` binding of the dev runtime, or \`fs-lite\` in \`${store.localBase}\` when the runtime has no binding.`
      : `Remote. \`vite dev\` uses the real Cloudflare KV namespace through the \`${store.binding}\` binding, so writes change real data.`
    case "deno-kv": return "Local. Deno KV."
    case "fs-lite": return `Local. \`fs-lite\` in \`${store.base}\`.`
  }
}

/** One summary per KV store: the build driver and what `vite dev` uses. */
export function inspectKVStores(build: ResolvedKVModuleOptions, dev: ResolvedKVModuleOptions, file: string): ViteHubDefinitionSummary[] {
  const devStores = dev.stores ?? { default: dev.store }
  return Object.entries(build.stores ?? { default: build.store }).map(([name, store]) => {
    const devStore = devStores[name]
    return {
      fields: [
        { label: "Driver", value: store.driver },
        ...devStore ? [{ label: "Development", value: describeDevelopment(devStore) }] : [],
      ],
      file,
      name,
      source: "kv",
    }
  })
}

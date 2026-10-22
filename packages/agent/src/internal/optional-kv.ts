// The package build folds `"@vite-hub/" + "kv"` into a literal, so build the specifier at runtime.
const optionalKVPackage: string = ["@vite-hub", "kv"].join("/")

/**
 * Loads the optional @vite-hub/kv package. A runtime specifier keeps it, and the #vitehub/kv/config
 * virtual module it imports, out of agent bundles that do not configure hubKv().
 */
export async function importOptionalKV(): Promise<typeof import("@vite-hub/kv")> {
  return await import(/* @vite-ignore */ optionalKVPackage) as typeof import("@vite-hub/kv")
}

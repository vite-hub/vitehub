/** Results of the `kv.*` operations, as `vitehub kv` and the Console read them. */

/** Largest `--limit` of one `list` page. */
export const kvDevMaximumListLimit = 1_000
/** Default `--limit` of one `list` page. */
export const kvDevDefaultListLimit = 100

/** The operations that `vitehub kv` runs, without the `kv.` prefix. There is no `clear` operation. */
export const kvOperationNames = ["list", "get", "has", "set", "del"] as const

export type KVDevOperation = typeof kvOperationNames[number]

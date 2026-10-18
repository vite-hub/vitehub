import type { ConnectionActivityRetention, ConnectionDefinitionRegistry, ConnectionsDatabaseLoader } from "../types.ts"

const registry: ConnectionDefinitionRegistry = {}

export const database: ConnectionsDatabaseLoader | undefined = undefined

/** Outside a Vite build the store uses the default activity retention. */
export const activityRetention: ConnectionActivityRetention | false | undefined = undefined

export default registry

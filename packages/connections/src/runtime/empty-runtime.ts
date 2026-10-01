import type { ConnectionsRuntimeModule } from "../types.ts"

/** Used when the app does not enable Connections. Every call fails with `CONNECTIONS_NOT_CONFIGURED`. */
const runtime: ConnectionsRuntimeModule = {
  database: () => undefined,
  encryptionKey: () => undefined,
  registry: {},
}

export default runtime

import { fallbackDatabasesMarker } from "./shared-runtime.ts"

// The registry of a copy of this package that no host gave its Databases, such as the copy that Node loads in `vite dev`.
const databases = Object.defineProperty({}, fallbackDatabasesMarker, { value: true })

export { databases }
export default databases

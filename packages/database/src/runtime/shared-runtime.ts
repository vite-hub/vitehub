/** Marks the empty registry of a copy of this package that no host gave its Databases. */
export const fallbackDatabasesMarker: unique symbol = Symbol.for("vitehub.database.fallback")

/** The `getRuntimeDatabases()` of the copy that has the app's Databases. */
export const sharedRuntimeKey: unique symbol = Symbol.for("vitehub.database.runtime")

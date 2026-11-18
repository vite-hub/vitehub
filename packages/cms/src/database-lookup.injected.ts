/**
 * Generated module source that reads the Database of the cms preset. The build loads the generated module without the
 * app's Databases, and `useDatabase()` throws for a missing one, so the module keeps the error and throws it on first
 * use. The text runs in the generated module, not here, so its error stays plain.
 */
export function renderDatabaseLookup(database: string): string[] {
  const missing = `[vitehub] The Content cms preset needs Database ${JSON.stringify(database)}, but it is not configured at runtime. Enable database in vitehub() and keep its Database Definition.`
  return [
    "let database",
    `try { database = useDatabase(${JSON.stringify(database)}).db }`,
    "catch (error) {",
    "  database = new Proxy({}, {",
    "    get() {",
    `      throw new Error(${JSON.stringify(missing)}, { cause: error })`,
    "    },",
    "  })",
    "}",
  ]
}

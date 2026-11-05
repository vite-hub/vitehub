import { defineDatabase } from "../definition.ts"

/** The default Database of an app without a Database Definition whose contributions need Postgres. It has no tables of its own. */
export default defineDatabase({ dialect: "postgresql", schema: {} })

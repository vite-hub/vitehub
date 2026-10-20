import { defineDatabase } from "../definition.ts"

/** The default Database of an app that enables `database` without a Database Definition. It has no tables of its own. */
export default defineDatabase({ schema: {} })

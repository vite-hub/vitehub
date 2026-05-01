import schema from "virtual:@vitehub/db/schema"

export { databases, db } from "./runtime/drizzle-runtime.ts"
export { schema }
export * from "virtual:@vitehub/db/schema"

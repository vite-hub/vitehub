/// <reference path="./virtual-module.d.ts" />

import schema from "virtual:@vitehub/db/schema"

export { db } from "./runtime/drizzle-runtime.ts"
export { schema }
export * from "virtual:@vitehub/db/schema"

import { defineWorkflow } from "../../src/definition.ts"

export default defineWorkflow<{ email: string }>(async ({ payload }) => ({ userId: `user:${payload.email}` }))

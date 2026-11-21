import { defineWorkflow } from "../../src/definition.ts"

export default defineWorkflow<{ email: string }>({ handler: async ({ payload }) => ({ userId: `user:${payload.email}` }) })

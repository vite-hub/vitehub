import { defineWorkflow } from "../../src/definition.ts"

export default defineWorkflow("onboard-user-import", async (payload: { email: string }) => ({ userId: `user:${payload.email}` }))

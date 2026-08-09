import { expectTypeOf } from "vitest"

import { vitehub } from "vite-hub"
import { defineAgent } from "vite-hub/agent"
import { email } from "vite-hub/agent/capabilities"
import { env } from "vite-hub/env"
import { requireRateLimit } from "vite-hub/rate-limit"
import { defineWorkflow } from "vite-hub/workflow"
import { defineWorkspace } from "vite-hub/workspace"

expectTypeOf(vitehub).toBeFunction()
vitehub({ preset: "node", rateLimit: true })
vitehub({ email: { driver: "unemail/driver/resend" }, preset: "node" })
// @ts-expect-error Email requires a configured provider.
vitehub({ email: true, preset: "node" })
vitehub({ name: "my-app", preset: "cloudflare", blob: true, rateLimit: true })
vitehub({ agent: true, database: true, preset: "node", workflow: true, workspace: true })
expectTypeOf(defineAgent).toBeFunction()
expectTypeOf(email).toBeFunction()
expectTypeOf(env).toBeFunction()
expectTypeOf(requireRateLimit).toBeFunction()
expectTypeOf(defineWorkspace).toBeFunction()
expectTypeOf(defineWorkflow).toBeFunction()

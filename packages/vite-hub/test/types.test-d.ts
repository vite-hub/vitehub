import { expectTypeOf } from "vitest"

import { vitehub } from "vite-hub"
import { defineAgent } from "vite-hub/agent"
import { email } from "vite-hub/agent/capabilities"
import { env } from "vite-hub/env"
import { defineRateLimit } from "vite-hub/rate-limit"
import { defineWorkflow } from "vite-hub/workflow"
import { defineWorkspace } from "vite-hub/workspace"

expectTypeOf(vitehub).toBeFunction()
vitehub({ rateLimit: true })
vitehub({ rateLimit: { provider: "cloudflare" } })
expectTypeOf(defineAgent).toBeFunction()
expectTypeOf(email).toBeFunction()
expectTypeOf(env).toBeFunction()
expectTypeOf(defineRateLimit).toBeFunction()
expectTypeOf(defineWorkspace).toBeFunction()
expectTypeOf(defineWorkflow).toBeFunction()

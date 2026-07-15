import { expectTypeOf } from "vitest"

import { vitehub } from "vite-hub"
import { defineAgent } from "vite-hub/agent"
import { email } from "vite-hub/agent/capabilities"
import { env } from "vite-hub/env"
import { defineWorkflow } from "vite-hub/workflow"
import { defineWorkspace } from "vite-hub/workspace"

expectTypeOf(vitehub).toBeFunction()
expectTypeOf(defineAgent).toBeFunction()
expectTypeOf(email).toBeFunction()
expectTypeOf(env).toBeFunction()
expectTypeOf(defineWorkspace).toBeFunction()
expectTypeOf(defineWorkflow).toBeFunction()

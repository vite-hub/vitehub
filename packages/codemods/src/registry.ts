import { agentSurface } from "./agent-surface/index.ts"
import { defineForms } from "./define-forms/index.ts"
import { nuxtCron } from "./nuxt-cron/index.ts"
import { nuxtSafeRuntimeConfig } from "./nuxt-safe-runtime-config/index.ts"
import { rootAccessors } from "./root-accessors/index.ts"
import { oneEntryImports } from "./one-entry-imports/index.ts"
import { queueWorkflowVerbs } from "./queue-workflow-verbs/index.ts"
import { resend } from "./resend/index.ts"
import { t3Env } from "./t3-env/index.ts"
import { vitehubOptions } from "./vitehub-options/index.ts"

import type { Codemod } from "./types.ts"

/** Every available codemod. Add a new codemod here to make the CLI list and run it. */
export const codemods: readonly Codemod[] = [
  nuxtSafeRuntimeConfig,
  t3Env,
  resend,
  rootAccessors,
  queueWorkflowVerbs,
  nuxtCron,
  defineForms,
  oneEntryImports,
  vitehubOptions,
  agentSurface,
]

/** Codemods that move an app between ViteHub releases. `vitehub migrate` runs them in order. */
export const upgradeCodemods: readonly Codemod[] = [
  rootAccessors,
]

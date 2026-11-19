import { accessSpellings } from "./access-spellings/index.ts"
import { agentSurface } from "./agent-surface/index.ts"
import { authAccessors } from "./auth-accessors/index.ts"
import { authSignIn } from "./auth-sign-in/index.ts"
import { channels } from "./channels/index.ts"
import { choicesPackage } from "./choices-package/index.ts"
import { defineForms } from "./define-forms/index.ts"
import { docus } from "./docus/index.ts"
import { driverKey } from "./driver-key/index.ts"
import { nuxtContent } from "./nuxt-content/index.ts"
import { nuxtCron } from "./nuxt-cron/index.ts"
import { nuxtSafeRuntimeConfig } from "./nuxt-safe-runtime-config/index.ts"
import { nuxthub } from "./nuxthub/index.ts"
import { rootAccessors } from "./root-accessors/index.ts"
import { oneEntryImports } from "./one-entry-imports/index.ts"
import { queueDurations } from "./queue-durations/index.ts"
import { queueWorkflowVerbs } from "./queue-workflow-verbs/index.ts"
import { renamedApis } from "./renamed-apis/index.ts"
import { resend } from "./resend/index.ts"
import { resultTuples } from "./result-tuples/index.ts"
import { runtimeContracts } from "./runtime-contracts/index.ts"
import { shellDriver } from "./shell-driver/index.ts"
import { t3Env } from "./t3-env/index.ts"
import { tsconfigPaths } from "./tsconfig-paths/index.ts"
import { vitehubOptions } from "./vitehub-options/index.ts"

import type { Codemod } from "./types.ts"

/**
 * Every available codemod. Add a new codemod here to make the CLI list and run it. NuxtHub runs first: it renames
 * hub to vitehub in place and picks the host from the Wrangler config, and the others add to that vitehub key.
 */
export const codemods: readonly Codemod[] = [
  nuxthub,
  nuxtSafeRuntimeConfig,
  t3Env,
  resend,
  rootAccessors,
  queueWorkflowVerbs,
  queueDurations,
  resultTuples,
  nuxtCron,
  docus,
  nuxtContent,
  runtimeContracts,
  defineForms,
  oneEntryImports,
  vitehubOptions,
  driverKey,
  agentSurface,
  renamedApis,
  tsconfigPaths,
  shellDriver,
  accessSpellings,
  authSignIn,
  channels,
  authAccessors,
  choicesPackage,
]

/**
 * Codemods that move an app between ViteHub releases. `vitehub migrate` runs each one that applies, in this order, and
 * each one sees the edits of the ones before it. Config codemods run first: `vitehub-options` moves top-level feature
 * keys into `vitehub()`, where `agent-surface` then renames the Agent driver keys. `define-forms` moves the Database
 * files before the import codemods rewrite them. `root-accessors` moves `#vitehub/env/server` to `vite-hub/env` before
 * `one-entry-imports` joins the `vite-hub/env/*` imports with it. `queue-durations` and `result-tuples` run after
 * `queue-workflow-verbs`, so they also read the calls that `queue-workflow-verbs` renamed. The codemods that move an
 * app from another module, such as NuxtHub, are not upgrades, so only `npx @vite-hub/codemods` runs them.
 */
export const upgradeCodemods: readonly Codemod[] = [
  vitehubOptions,
  defineForms,
  runtimeContracts,
  rootAccessors,
  oneEntryImports,
  queueWorkflowVerbs,
  queueDurations,
  resultTuples,
  agentSurface,
  driverKey,
  renamedApis,
  tsconfigPaths,
  shellDriver,
  accessSpellings,
  authSignIn,
  channels,
  authAccessors,
  choicesPackage,
]

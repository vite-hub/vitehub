import { existsSync, readdirSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { viteHubPageToolsBase } from "@vite-hub/internal/build/page-tools"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { installStandaloneOperationRpc, publishStandaloneOperationServer } from "@vite-hub/internal/operations-vite"

import { formsDiagnostics } from "./errors.ts"
import { formsTableNames } from "./table-names.ts"

import type { OperationContributions } from "@vite-hub/internal/operations"
import type { Plugin, UserConfig } from "vite"

export const FORMS_VITE_PLUGIN_NAME = "@vite-hub/forms/vite"

/** The route of every form, below the app base. */
export const formsRoute = "/api/_vitehub/forms"

const extensions = [".ts", ".mts", ".js", ".mjs"]
const namePattern = /^[a-z0-9][a-z0-9-]*$/

/** One file of `server/forms/`. */
export interface DiscoveredForm {
  name: string
  file: string
}

/** The forms of `<serverDir>/forms/<name>.ts`. A name is lowercase letters, digits, and dashes. */
export function discoverForms(projectRoot: string, serverDirs: readonly string[] = ["server"]): DiscoveredForm[] {
  const found = new Map<string, DiscoveredForm>()
  for (const directory of serverDirs) {
    const folder = resolve(projectRoot, directory, "forms")
    if (!existsSync(folder)) continue
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const extension = extensions.find(candidate => entry.name.endsWith(candidate))
      if (!entry.isFile() || !extension || entry.name.endsWith(".d.ts")) continue
      const name = entry.name.slice(0, -extension.length)
      const file = join(folder, entry.name)
      if (!namePattern.test(name)) {
        throw formsDiagnostics.FORMS_B0001({ message: `[vitehub] The form ${relative(projectRoot, file)} needs a name of lowercase letters, digits, and dashes, such as contact or bug-report.` })
      }
      if (found.has(name)) {
        throw formsDiagnostics.FORMS_B0001({ message: `[vitehub] Two files define the form ${JSON.stringify(name)}: ${relative(projectRoot, found.get(name)!.file)} and ${relative(projectRoot, file)}.` })
      }
      found.set(name, { name, file })
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/** Whether the app has a form. `vite-hub` uses it to turn the Database on. */
export function usesForms(options: { projectRoot: string, serverDirs?: readonly string[] }): boolean {
  return discoverForms(options.projectRoot, options.serverDirs).length > 0
}

/** The module specifiers that the generated handler imports. `vite-hub` passes its own subpaths. */
export interface FormsImports {
  runtime: string
  operations: string
  database: string
  databases?: string
  email?: string
  auth?: string
  standard?: string
}

export interface HubFormsOptions {
  imports?: Partial<FormsImports>
  /** The app has a ViteHub Database: store submissions there. Without it, they stay in memory. */
  database?: boolean
  /** The app has ViteHub Email: send `notify.email` with it. */
  email?: boolean
  /** The app has ViteHub Auth: pass the signed-in user to `authorize`. */
  auth?: boolean
}

const defaultImports: FormsImports = {
  runtime: "@vite-hub/forms/runtime",
  operations: "@vite-hub/forms/operations",
  database: "@vite-hub/forms/database",
  databases: "@vite-hub/database/runtime/registry",
  email: "@vite-hub/email",
  auth: "@vite-hub/auth/server",
  standard: "@vite-hub/runtime",
}

/** The generated `{ fetch }` route of every form. */
export function renderFormsHandler(forms: readonly DiscoveredForm[], options: HubFormsOptions & { imports: FormsImports }): string {
  const { imports } = options
  const lines = [
    `import { createFormsHandler } from ${JSON.stringify(imports.runtime)}`,
    ...imports.standard ? [`import { getStandardContext } from ${JSON.stringify(imports.standard)}`] : [],
    ...options.database && imports.databases ? [`import { databases } from ${JSON.stringify(imports.databases)}`] : [],
    ...options.email && imports.email ? [`import { email } from ${JSON.stringify(imports.email)}`] : [],
    ...options.auth && imports.auth ? [`import { useAuth } from ${JSON.stringify(imports.auth)}`] : [],
    ...forms.map((form, index) => `import form${index} from ${JSON.stringify(form.file)}`),
    "",
    "export default createFormsHandler({",
    `  forms: { ${forms.map((form, index) => `${JSON.stringify(form.name)}: form${index}`).join(", ")} },`,
    ...options.database && imports.databases ? ["  databases,"] : [],
    ...options.email && imports.email ? ["  sendEmail: message => email.send(message),"] : [],
    ...options.auth && imports.auth
      ? [
          "  session: async (request) => {",
          "    const session = await useAuth(request).api.getSession({ headers: request.headers })",
          "    const user = session?.user",
          "    return user && typeof user.id === \"string\" ? { id: user.id, ...(user.name ? { name: user.name } : {}), ...(user.email ? { email: user.email } : {}) } : null",
          "  },",
        ]
      : [],
    ...imports.standard ? ["  context: (request) => getStandardContext(request),"] : [],
    "})",
    "",
  ]
  return lines.join("\n")
}

/**
 * Forms in a ViteHub app: each `server/forms/<name>.ts` that default-exports `defineForm()` gets the route
 * `POST <base>api/_vitehub/forms/<name>`, and its submissions go to the `vitehub_form_submissions` table of the
 * default Database.
 */
export function hubForms(options: HubFormsOptions = {}): Plugin & { vitehub: { databases: (context: { projectRoot?: string, root?: string, rootDir?: string }) => unknown[], operations: OperationContributions } } {
  const imports: FormsImports = { ...defaultImports, ...options.imports }
  let projectRoot: string | undefined
  let serverDirs: readonly string[] | undefined
  return {
    name: FORMS_VITE_PLUGIN_NAME,
    enforce: "pre",
    vitehub: {
      // The Console, `vitehub forms`, and MCP read the inbox through these operations.
      operations: () => usesForms({ projectRoot: projectRoot ?? process.cwd(), ...(serverDirs ? { serverDirs } : {}) })
        ? [{ export: "formsOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).formsOperations, module: imports.operations }]
        : [],
      databases(context) {
        const root = projectRoot ?? context.projectRoot ?? context.rootDir ?? context.root ?? process.cwd()
        if (!options.database || !usesForms({ projectRoot: root, ...(serverDirs ? { serverDirs } : {}) })) return []
        return [{
          definition: { export: "formsSchema", module: imports.database },
          dialect: "sqlite",
          tables: formsTableNames,
          name: "forms",
          reason: "Stores the submissions of `server/forms/`.",
        }]
      },
    },
    config: {
      async handler(config: UserConfig, env) {
        const configuredRoot: unknown = Reflect.get(config, VITEHUB_PROJECT_ROOT)
        projectRoot = typeof configuredRoot === "string" ? resolve(configuredRoot) : resolveViteHubProjectRoot(resolve(config.root ?? process.cwd()))
        const dirs: unknown = Reflect.get(config, VITEHUB_SERVER_DIRS)
        serverDirs = Array.isArray(dirs) ? dirs.filter((dir): dir is string => typeof dir === "string") : undefined
        const directory = resolve(projectRoot, ".vitehub/nitro/forms")
        const forms = discoverForms(projectRoot, serverDirs)
        if (!forms.length) {
          await rm(directory, { force: true, recursive: true })
          return
        }
        await mkdir(directory, { recursive: true })
        const handler = join(directory, "handler.mjs")
        await writeFile(handler, renderFormsHandler(forms, { ...options, imports }))
        const { mount } = viteHubPageToolsBase(config)
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
        // Not lazy: the handler installs the inbox when the server starts, so server code reads it before any submission.
        kit.addHandler({ handler, lazy: false, route: `${mount}${formsRoute}/**` })
        Reflect.set(config, "nitro", kit.config)
        await installStandaloneOperationRpc(config, env?.command ?? "build", imports.operations)
      },
    },
    configureServer(server) {
      publishStandaloneOperationServer(server)
    },
  }
}
export { formsConsoleSection } from "./console.ts"

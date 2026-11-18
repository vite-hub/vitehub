import { relative, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { hasDefinitionFiles } from "@vite-hub/internal/definition-catalog"
import { features } from "@vite-hub/internal/features"

import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"
import { forgetPackageChecks, installArguments, isPackageInstalled, optionalFeaturePackages } from "./optional-owners.ts"

import type { Plugin } from "vite"

/**
 * The features that a Definition file turns on when the app does not set their key, such as Auth with
 * `server/auth.ts` or Queue with `server/queues/`. `x: false` keeps a feature off, and `x: {…}` sets its options.
 * The feature catalog lists the files of each feature in `enabledByDiscovery`.
 */
const definitionFeatureIds = ["agent", "auth", "browser", "channels", "connections", "queue", "realtime", "schedule", "workflow", "workspace"] as const

type DefinitionFeature = (typeof definitionFeatureIds)[number]

type DefinitionFeatureOptions = { [K in DefinitionFeature]?: unknown }

interface DefinitionProject {
  projectRoot: string
  serverDirs?: readonly string[]
}

/** The first Definition file or folder of each feature whose key is unset, relative to the project root. */
function discoverDefinitionFeatures(options: DefinitionFeatureOptions, project: DefinitionProject): Map<DefinitionFeature, string> {
  const serverDirs = project.serverDirs ?? ["server"]
  const found = new Map<DefinitionFeature, string>()
  for (const id of definitionFeatureIds) {
    if (options[id] !== undefined) continue
    const file = serverDirs.flatMap(directory => (features[id].enabledByDiscovery ?? []).map(name => resolve(project.projectRoot, directory, name)))
      .find(candidate => hasDefinitionFiles(candidate))
    if (file) found.set(id, relative(project.projectRoot, file))
  }
  return found
}

function missingPackages(id: DefinitionFeature): string[] {
  return optionalFeaturePackages[id].filter(name => !isPackageInstalled(name))
}

/**
 * Turns on each feature whose key is unset and whose Definition file exists. It fails with the `pnpm add` command when
 * a Definition file exists and its package is not installed.
 */
export function resolveDefinitionFeatures<T extends DefinitionFeatureOptions>(options: T, project: DefinitionProject): T {
  const found = discoverDefinitionFeatures(options, project)
  if (!found.size) return options
  let missing = [...found.keys()].filter(id => missingPackages(id).length)
  if (missing.length) {
    // The app can install a package after an earlier check, such as after this error in a dev session. Check again.
    forgetPackageChecks()
    missing = missing.filter(id => missingPackages(id).length)
  }
  if (missing.length) {
    const packages = [...new Set(missing.flatMap(missingPackages))]
    throw viteHubErrorDiagnostics.VITE_HUB_DEFINITION_PACKAGE_MISSING({
      definitions: missing.map(id => `${found.get(id)} turns ${features[id].title} on`).join(", and "),
      install: installArguments(packages).join(" "),
      off: missing.map(id => `\`${id}: false\``).join(", "),
      packages: packages.join(", "),
    })
  }
  return { ...options, ...Object.fromEntries([...found.keys()].map(id => [id, true])) }
}

/**
 * `vitehub()` looks for Definition files in the project of the working directory, because Vite gives the plugins its
 * root only later. This plugin fails the build when the Vite root is another project with other Definition files, so a
 * feature is never on or off by mistake.
 */
export function definitionFeaturesRootPlugin(options: DefinitionFeatureOptions, project: DefinitionProject): Plugin {
  const guessed = [...discoverDefinitionFeatures(options, project).keys()]
  return {
    name: "vite-hub/definition-features-root",
    configResolved(config) {
      // SAFETY: The resolved config keeps ViteHub's shared keys from the config hook.
      const viteConfig = config as typeof config & { [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[] }
      const projectRoot = viteConfig[VITEHUB_PROJECT_ROOT] ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(config.root)
      const serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      if (projectRoot === project.projectRoot && !serverDirs) return
      const found = discoverDefinitionFeatures(options, { projectRoot, serverDirs })
      const changed = definitionFeatureIds.filter(id => found.has(id) !== guessed.includes(id))
      if (!changed.length) return
      throw viteHubErrorDiagnostics.VITE_HUB_DEFINITION_ROOT_MISMATCH({
        keys: changed.map(id => `\`${id}\``).join(", "),
        projectRoot,
        workingDirectory: project.projectRoot,
      })
    },
  }
}

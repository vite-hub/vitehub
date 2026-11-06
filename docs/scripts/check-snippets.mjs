// Type-checks every TypeScript code block in the docs and in the package READMEs against the built
// workspace packages. Build them first: `vp run --cache -t vite-hub#build`.
//
// Each page is a small project: a block with a file label, such as ```ts [server/db/schema.ts], is written
// at that path, so the other blocks of the page can import it. A block that is an excerpt of a larger file
// must say so with `fragment` in its fence meta: ```ts [server/agents/support.ts] fragment. A block that shows a
// mistake on purpose names the errors it must fail with: ```ts [server/auth.ts] fails=TS2769.
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const docsRoot = join(repoRoot, "docs")
const packagesRoot = join(repoRoot, "packages")
const fenceLanguages = new Set(["ts", "typescript", "tsx", "mts"])
export const fragmentMarker = "fragment"
export const failsMarker = "fails"

function listMarkdown(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
}

function packageRoots() {
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json")))
    .map(entry => join(packagesRoot, entry.name))
    .sort()
}

/** Docs pages resolve imports from `docs/`, and a README from its own package. */
export function snippetSources() {
  const docs = listMarkdown(join(docsRoot, "content/docs")).map(file => ({ file, root: docsRoot }))
  const readmes = packageRoots()
    .map(root => ({ file: join(root, "README.md"), root }))
    .filter(source => existsSync(source.file))
  return [...docs, ...readmes]
}

export function extractBlocks(markdown) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n")
  const blocks = []
  for (let index = 0; index < lines.length; index++) {
    const open = /^(\s*)(`{3,}|~{3,})(\S*)\s*(.*)$/.exec(lines[index])
    if (!open) continue
    const [, indent, fence, language, info] = open
    const close = new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`)
    const body = []
    let end = index + 1
    while (end < lines.length && !close.test(lines[end])) {
      body.push(lines[end].startsWith(indent) ? lines[end].slice(indent.length) : lines[end].trimStart())
      end++
    }
    if (fenceLanguages.has(language)) {
      // READMEs name the file in a first-line comment, such as `// server/workflows/onboard-user/index.ts`.
      const label = /\[(.+)\]/.exec(info)?.[1] ?? /^\/\/ (\S+\.(?:m?ts|tsx))$/.exec(body[0] ?? "")?.[1]
      const meta = info.replace(/\[.+\]/, "").split(/\s+/).filter(Boolean)
      const fails = meta.find(entry => entry.startsWith(`${failsMarker}=`))?.slice(failsMarker.length + 1).split(",").map(code => Number(code.replace(/^TS/, "")))
      blocks.push({ code: body.join("\n"), end: end + 1, fails, fragment: meta.includes(fragmentMarker), indent, label, language, line: index + 1 })
    }
    index = end
  }
  return blocks
}

const options = {
  allowImportingTsExtensions: true,
  esModuleInterop: true,
  jsx: ts.JsxEmit.Preserve,
  lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts", "lib.dom.asynciterable.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleDetection: ts.ModuleDetectionKind.Force,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ESNext,
  types: ["node"],
}

/** The declarations that ViteHub writes for an app with no `server/env.ts`, and the Vue shim of a Vite app. */
const ambientFiles = [join(packagesRoot, "env/dist/virtual-module.d.ts")]
const nuxtModules = {
  "@nuxt/ui": "ui",
  "@vite-hub/database/nuxt": "database",
  "@vite-hub/docs/nuxt": "docs",
  "@vite-hub/ui/nuxt": "viteHubUI",
  "vite-hub/nuxt": "vitehub",
}
const appDeclarations = [
  {
    code: [
      `declare module "*.vue" {`,
      `  const component: import("vue").DefineComponent`,
      `  export default component`,
      `}`,
    ].join("\n"),
    file: join(docsRoot, ".snippets/vue-shim.d.ts"),
  },
  {
    // Nuxt writes these options into `.nuxt/types/modules.d.ts` for the modules that an app installs.
    code: [
      `declare module "@nuxt/schema" {`,
      `  interface NuxtConfig {`,
      // A module's options are the first parameter of its setup function, whichever `@nuxt/schema` it uses.
      ...Object.entries(nuxtModules).map(([module, key]) => `    ${key}?: typeof import("${module}").default extends (options: infer O, ...rest: never[]) => unknown ? Partial<O> | false : never`),
      `  }`,
      `}`,
      `export {}`,
    ].join("\n"),
    file: join(docsRoot, ".snippets/nuxt-modules.d.ts"),
  },
]

/** Nuxt declares `defineNuxtConfig()` globally in `nuxt.config.ts`. */
function withAppGlobals(snippet) {
  const nuxtConfig = /(^|\/)nuxt\.config\.ts$/.test(snippet.label ?? "") || /^export default defineNuxtConfig\(/m.test(snippet.code)
  if (!nuxtConfig || /^import\b[^\n]*\bdefineNuxtConfig\b/m.test(snippet.code)) return snippet.code
  return `${snippet.code}\ndeclare var defineNuxtConfig: typeof import("nuxt/config").defineNuxtConfig\n`
}

/** Lists the blocks of every page as virtual files, one folder per page. */
export function collectSnippets(sources = snippetSources()) {
  const snippets = []
  for (const source of sources) {
    const page = relative(repoRoot, source.file)
    const used = new Set()
    extractBlocks(readFileSync(source.file, "utf8")).forEach((block, index) => {
      const extension = block.language === "tsx" ? ".tsx" : ".ts"
      let name = block.label && /\.(m?ts|tsx)$/.test(block.label) ? block.label.replace(/^\/+/, "") : `block-${index}${extension}`
      if (used.has(name)) name = `${index}/${name}`
      used.add(name)
      const pageRoot = join(source.root, ".snippets", page.replaceAll("/", "__"))
      snippets.push({ ...block, file: join(pageRoot, name), page, pageRoot })
    })
  }
  return snippets
}

/** A whole file of the page's app. Excerpts and examples of mistakes are not part of it. */
const isAppFile = snippet => !snippet.fragment && !snippet.fails

const workflowStepFile = /(?:^|\/)workflows\/(.+)\/(\d+[.-]?[^/]*\.m?ts)$/

/**
 * The declarations that ViteHub writes to `.vitehub/` for the files of one page: the registries of the
 * Definitions that the page shows, and the step types of each folder Workflow whose numbered step files it shows.
 */
export async function generatedDeclarations(pageSnippets) {
  const workflows = new Map()
  for (const snippet of pageSnippets) {
    const match = workflowStepFile.exec(snippet.label ?? "")
    if (!match || !isAppFile(snippet)) continue
    const definition = workflows.get(match[1]) ?? { handler: snippet.file.slice(0, -match[2].length - 1), name: match[1], steps: [] }
    definition.steps.push(snippet.file)
    workflows.set(match[1], definition)
  }
  const declarations = [...registryDeclarations(pageSnippets), ...await envDeclarations(pageSnippets)]
  if (!workflows.size) return declarations
  const { createWorkflowTypes } = await import(pathToFileURL(join(packagesRoot, "workflow/dist/vite.js")).href)
  const file = join(pageSnippets[0].pageRoot, ".vitehub/workflow.d.ts")
  return [...declarations, { code: createWorkflowTypes(file, [...workflows.values()], "@vite-hub/workflow"), file }]
}

/**
 * A file below `server/<directory>/` is one Definition named after its path, and `<name>/index.ts` is named after
 * its folder. Elsewhere, `src/<name>.<kind>.ts` defines `<name>`.
 */
function definitionName(directory, kind) {
  const server = new RegExp(`^server/${directory}/(.+?)(?:/index)?(?:\\.${kind})?\\.m?ts$`)
  const suffix = new RegExp(`^(?:src/)?(.+)\\.${kind}\\.m?ts$`)
  return (label) => {
    const name = server.exec(label)?.[1] ?? suffix.exec(label)?.[1]
    return name ? [name] : []
  }
}

const globalModules = name => entries => ["declare global {", `  interface ${name} {`, ...entries.map(([key, path]) => `    ${key}: typeof import(${path})`), "  }", "}", "export {}"]

/**
 * The registries that ViteHub generates from the Definitions of an app, in the form that each package writes them.
 * A page shows the Definitions that its other blocks use by name, such as `runQueue('welcome-email')`.
 */
const registries = [
  {
    // @vite-hub/queue: src/registry-types.ts
    definitions: definitionName("queues", "queue"),
    render: entries => [`import "@vite-hub/queue"`, `declare module "@vite-hub/queue" {`, "  interface QueueRegistry {", ...entries.map(([key, path]) => `    ${key}: typeof import(${path}).default`), "  }", "}"],
    type: "queue",
  },
  // @vite-hub/channels, @vite-hub/connections, and @vite-hub/browser: `renderRegistryTypes()` in src/vite.ts
  { definitions: definitionName("channels", "channel"), render: globalModules("ViteHubChannelDefinitionModules"), type: "channels" },
  { definitions: definitionName("connections", "connection"), render: globalModules("ViteHubConnectionDefinitionModules"), type: "connections" },
  { definitions: definitionName("browsers", "browser"), render: globalModules("ViteHubBrowserDefinitionModules"), type: "browser" },
  {
    // @vite-hub/source: `writeCollectionArtifacts()` in src/vite.ts. Each `defineCollection()` export of a module in
    // `server/collections/` is one Collection named after its export.
    definitions: (label, code) => /^server\/collections\/.+\.m?ts$/.test(label)
      ? [...code.matchAll(/^export const (\w+) = defineCollection\b/gm)].map(match => match[1])
      : [],
    render: entries => ["declare global {", "  interface ViteHubCollectionMap {", ...entries.map(([key, path, name]) => `    ${key}: typeof import(${path})[${JSON.stringify(name)}]`), "  }", "}", "export {}"],
    type: "collections",
  },
  {
    // @vite-hub/database: src/internal/generated.ts. `server/databases/config.ts` and `src/database.ts` define the
    // `default` Database, and `server/databases/<name>/config.ts` a named one.
    definitions: (label) => {
      if (/^(?:server\/databases\/config|src\/database)\.m?ts$/.test(label)) return ["default"]
      const name = /^server\/databases\/(.+)\/config\.m?ts$/.exec(label)?.[1] ?? /^(?:src\/)?(.+)\.database\.m?ts$/.exec(label)?.[1]
      return name ? [name] : []
    },
    render: entries => ["@vite-hub/database/drizzle", "vite-hub/database/drizzle"].flatMap(module => [
      `import ${JSON.stringify(module)}`,
      `declare module ${JSON.stringify(module)} {`,
      "  interface DatabaseRegistry {",
      ...entries.map(([key, path]) => `    ${key}: { schema: typeof import(${path}).default.schema }`),
      "  }",
      "}",
    ]),
    type: "database",
  },
]

function registryDeclarations(pageSnippets) {
  const declarations = []
  for (const registry of registries) {
    const definitions = new Map()
    for (const snippet of pageSnippets) {
      if (!isAppFile(snippet) || !snippet.label) continue
      const label = snippet.label.replace(/^\/+/, "")
      for (const name of registry.definitions(label, snippet.code)) if (!definitions.has(name)) definitions.set(name, snippet.file)
    }
    if (!definitions.size) continue
    const file = join(pageSnippets[0].pageRoot, `.vitehub/${registry.type}.d.ts`)
    const entries = [...definitions].map(([name, handler]) => {
      const path = relative(dirname(file), handler).replace(/\.m?ts$/, "")
      return [JSON.stringify(name), JSON.stringify(path.startsWith(".") ? path : `./${path}`), name]
    })
    declarations.push({ code: `${registry.render(entries).join("\n")}\n`, file })
  }
  return declarations
}

const viteConfigFile = /(?:^|\/)vite\.config\.m?ts$/

/**
 * The Server Env and Public Env types of the `env` options that the page's `vite.config.ts` blocks set, from the
 * generator of `@vite-hub/env/vite`. Node runs each config from `packages/vite-hub`, so it imports what an app installs.
 */
async function envDeclarations(pageSnippets) {
  const configs = pageSnippets.filter(snippet => isAppFile(snippet) && viteConfigFile.test(snippet.label ?? "") && /\benv\s*:/.test(snippet.code))
  if (!configs.length) return []
  const env = { public: {}, server: {} }
  const directory = mkdtempSync(join(packagesRoot, "vite-hub/.snippet-config-"))
  try {
    for (const [index, snippet] of configs.entries()) {
      const file = join(directory, `${index}.ts`)
      writeFileSync(file, snippet.code)
      // A config that throws gets no Env types. The type check reports what is wrong with it.
      const config = await import(pathToFileURL(file).href).then(module => module.default, () => undefined)
      Object.assign(env.public, config?.env?.public)
      Object.assign(env.server, config?.env?.server)
    }
  }
  finally {
    rmSync(directory, { force: true, recursive: true })
  }
  const { createEnvTypes } = await import(pathToFileURL(join(packagesRoot, "env/dist/vite.js")).href)
  const pageRoot = pageSnippets[0].pageRoot
  // `vitehub()` registers Env, so the Auth integration types the `env` of `defineAuth()` as the Server Env.
  const authEnv = [
    `import type { ServerEnv } from "#vitehub/env/server"`,
    "declare global {",
    "  namespace ViteHub {",
    "    interface AuthRuntimeEnv extends ServerEnv {}",
    "  }",
    "}",
    "",
  ].join("\n")
  return [
    { code: createEnvTypes(env), file: join(pageRoot, envTypesFile) },
    { code: authEnv, file: join(pageRoot, ".vitehub/types/auth.d.ts") },
  ]
}

/** The page's generated Env types replace the untyped `#vitehub/env` declarations of an app without Env options. */
const envTypesFile = ".vitehub/types/env.d.ts"

/**
 * The installed files that the programs read, parsed once. Each page with generated declarations gets its own
 * program, and TypeScript binds a shared file only once.
 */
const installedSourceFiles = new Map()
/** Module resolutions from installed files and from the roots that a snippet's bare imports resolve from. */
const installedResolutions = new Map()

/** Type-checks the snippets and returns the diagnostics of each one that fails. */
export function checkSnippets(snippets, declarations = [], oldProgram = undefined) {
  const virtualFiles = new Map([
    ...[...appDeclarations, ...declarations].map(declaration => [declaration.file, declaration.code]),
    ...snippets.map(snippet => [snippet.file, withAppGlobals(snippet)]),
  ])
  // A page can show one file several times as it grows. A relative import gets the last full version of the
  // file that the page shows above the importing block, and a later version imports as if it were at its label.
  const versions = new Map()
  const labelFiles = new Map()
  for (const snippet of snippets) {
    if (!snippet.pageRoot || !/\.(m?ts|tsx)$/.test(snippet.label ?? "")) continue
    const file = join(snippet.pageRoot, snippet.label.replace(/^\/+/, ""))
    labelFiles.set(snippet.file, file)
    versions.set(file, [...versions.get(file) ?? [], snippet])
  }
  const lines = new Map(snippets.map(snippet => [snippet.file, snippet.line]))
  const shownVersion = (file, importer) => {
    const shown = versions.get(file).filter(isAppFile)
    const line = lines.get(importer) ?? Number.POSITIVE_INFINITY
    return (shown.findLast(snippet => snippet.line < line) ?? shown[0])?.file ?? file
  }
  const virtualDirectories = new Set()
  for (const file of virtualFiles.keys()) {
    for (let directory = dirname(file); directory !== dirname(directory) && !virtualDirectories.has(directory); directory = dirname(directory)) virtualDirectories.add(directory)
  }
  const host = ts.createCompilerHost(options)
  const fileExists = host.fileExists.bind(host)
  const readFile = host.readFile.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  const directoryExists = host.directoryExists.bind(host)
  host.fileExists = file => virtualFiles.has(file) || fileExists(file)
  host.readFile = file => virtualFiles.get(file) ?? readFile(file)
  host.directoryExists = directory => virtualDirectories.has(directory) || directoryExists(directory)
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) => {
    if (virtualFiles.has(file)) return ts.createSourceFile(file, virtualFiles.get(file), languageVersion, true)
    let sourceFile = installedSourceFiles.get(file)
    if (!sourceFile) {
      sourceFile = getSourceFile(file, languageVersion, onError, shouldCreate)
      if (sourceFile) installedSourceFiles.set(file, sourceFile)
    }
    return sourceFile
  }
  // A docs snippet gets the packages of a ViteHub app first, such as h3 v2, then those of the docs site.
  // A snippet may also import any package that the workspace installs, such as `zod`.
  const appRoot = join(packagesRoot, "vite-hub/__snippet.ts")
  const singletons = new Set(["vite"])
  const fallbackRoots = [docsRoot, ...packageRoots()].map(root => join(root, "__snippet.ts"))
  // `@nuxt/schema` resolves from the Nuxt that `nuxt/config` resolves to, so the module options in
  // `appDeclarations` extend the `NuxtConfig` that `defineNuxtConfig()` checks.
  const nuxtRoot = [appRoot, ...fallbackRoots].map(root => ts.resolveModuleName("nuxt/package.json", root, options, host).resolvedModule).find(Boolean)
  const schemaRoot = nuxtRoot && join(dirname(realpathSync(nuxtRoot.resolvedFileName)), "__snippet.ts")
  const resolveModuleName = (text, root) => {
    if (virtualFiles.has(root)) return ts.resolveModuleName(text, root, options, host)
    const key = `${text}\0${root}`
    if (!installedResolutions.has(key)) installedResolutions.set(key, ts.resolveModuleName(text, root, options, host))
    return installedResolutions.get(key)
  }
  host.resolveModuleNameLiterals = (literals, containingFile) => literals.map(({ text }) => {
    if (virtualFiles.has(containingFile) && /^\.\.?\//.test(text)) {
      const resolved = ts.resolveModuleName(text, labelFiles.get(containingFile) ?? containingFile, options, host)
      const file = resolved.resolvedModule?.resolvedFileName
      if (!file || !versions.has(file)) return resolved
      return { ...resolved, resolvedModule: { ...resolved.resolvedModule, resolvedFileName: shownVersion(file, containingFile) } }
    }
    const bare = !/^[./~#]/.test(text)
    // An app installs one Vite. The workspace links one per set of peer versions, and the package
    // declarations would otherwise compare plugins of two Vite copies.
    if (singletons.has(text.split("/")[0])) return resolveModuleName(text, appRoot)
    const roots = !virtualFiles.has(containingFile) || !bare
      ? [containingFile]
      : text === "@nuxt/schema" && schemaRoot
        ? [schemaRoot]
        : containingFile.startsWith(`${docsRoot}/`) ? [appRoot, containingFile, ...fallbackRoots] : [containingFile, ...fallbackRoots]
    let resolved
    for (const root of roots) {
      resolved = resolveModuleName(text, root)
      if (resolved.resolvedModule) return resolved
    }
    return resolved
  })

  const typedEnv = declarations.some(declaration => declaration.file.endsWith(`/${envTypesFile}`))
  const program = ts.createProgram([...typedEnv ? [] : ambientFiles, ...virtualFiles.keys()], options, host, oldProgram)
  const failures = []
  for (const snippet of snippets) {
    if (snippet.fragment) continue
    const sourceFile = program.getSourceFile(snippet.file)
    let diagnostics
    try {
      diagnostics = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)]
    }
    catch (error) {
      diagnostics = [{ code: 0, file: sourceFile, messageText: `TypeScript crashed: ${String(error).split("\n")[0]}`, start: 0 }]
    }
    if (snippet.fails) {
      // A mistake on purpose passes when it fails with exactly the errors that its marker names.
      const codes = new Set(diagnostics.map(diagnostic => diagnostic.code))
      const missing = snippet.fails.filter(code => !codes.has(code))
      diagnostics = diagnostics.filter(diagnostic => !snippet.fails.includes(diagnostic.code))
      if (missing.length) diagnostics.unshift({ code: 0, file: sourceFile, messageText: `The block is marked \`${failsMarker}=${snippet.fails.map(code => `TS${code}`).join(",")}\`, but it does not fail with ${missing.map(code => `TS${code}`).join(", ")}.`, start: 0 })
    }
    if (!diagnostics.length) continue
    failures.push({
      snippet,
      diagnostics: diagnostics.map(diagnostic => ({
        code: diagnostic.code,
        line: snippet.line + 1 + sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      })),
    })
  }
  return { failures, program }
}

export function snippetId(snippet) {
  return `${snippet.page}#${createHash("sha256").update(snippet.code.trim()).digest("hex").slice(0, 12)}`
}

/**
 * Blocks that failed when this check started. Each package fixes its own entries and removes them; the
 * check fails when a listed block passes or changes, so the list only shrinks.
 */
export const baselinePath = join(docsRoot, "scripts/check-snippets.baseline.json")

function readBaseline() {
  return existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : []
}

/** Expected-error assertions always fail on a mismatch, even if a baseline once listed them. */
export function checkBaseline(failures, baseline) {
  const ordinary = failures.filter(({ snippet }) => !snippet.fails)
  const entries = ordinary.map(({ snippet, diagnostics }) => {
    const diagnostic = diagnostics.find(entry => entry.code !== 2304 && entry.code !== 2307) ?? diagnostics[0]
    return { id: snippetId(snippet), label: snippet.label ?? null, error: `TS${diagnostic.code} ${diagnostic.message.split("\n")[0]}` }
  })
  const known = new Set(baseline.map(entry => entry.id))
  const failed = new Set(entries.map(entry => entry.id))
  return {
    entries,
    fresh: failures.filter(({ snippet }) => snippet.fails || !known.has(snippetId(snippet))),
    stale: baseline.filter(entry => !failed.has(entry.id)),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const snippets = collectSnippets()
  // A page with generated declarations, such as Workflow step types, gets its own program, because two pages
  // can define the same Workflow name. The other pages share one program.
  const shared = []
  const separate = []
  for (const pageSnippets of Map.groupBy(snippets, snippet => snippet.page).values()) {
    const declarations = await generatedDeclarations(pageSnippets)
    if (declarations.length) separate.push({ declarations, pageSnippets })
    else shared.push(...pageSnippets)
  }
  const sharedCheck = checkSnippets(shared)
  const failures = [
    ...sharedCheck.failures,
    ...separate.flatMap(({ declarations, pageSnippets }) => checkSnippets(pageSnippets, declarations, sharedCheck.program).failures),
  ]
  const { entries, fresh, stale } = checkBaseline(failures, readBaseline())
  if (process.argv.includes("--update-baseline") && !failures.some(({ snippet }) => snippet.fails)) {
    writeFileSync(baselinePath, `${JSON.stringify(entries, null, 2)}\n`)
    console.log(`Wrote ${entries.length} known failures to ${relative(repoRoot, baselinePath)}.`)
    process.exit(0)
  }
  for (const { snippet, diagnostics } of fresh) {
    for (const diagnostic of diagnostics) console.error(`${snippet.page}:${diagnostic.line} TS${diagnostic.code} ${diagnostic.message.split("\n")[0]}`)
  }
  for (const entry of stale) console.error(`${entry.id} passes now or changed. Remove it from ${relative(repoRoot, baselinePath)}.`)
  const fragments = snippets.filter(snippet => snippet.fragment).length
  const mistakes = snippets.filter(snippet => snippet.fails).length
  console.log(`${snippets.length - fragments} TypeScript blocks type-checked, ${fragments} marked \`${fragmentMarker}\`, ${mistakes} marked \`${failsMarker}\`, ${failures.length} failed, ${failures.length - fresh.length} of them listed as known failures.`)
  if (fresh.length) console.log(`Fix each block, add \`${fragmentMarker}\` to the fence meta of a block that is an excerpt of a larger file, or \`${failsMarker}=TS<code>\` to a block that shows a type error on purpose.`)
  if (fresh.length || stale.length) process.exitCode = 1
}

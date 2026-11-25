import { transformAsync, transformFromAstAsync } from "@babel/core"
import linguiMacroPlugin from "@lingui/babel-plugin-lingui-macro"

import { macroNames } from "./lingui.ts"

import type { FileResult, InputOptions, PluginObject, types as BabelTypes } from "@babel/core"
import type { LinguiConfigNormalized } from "@lingui/conf"

export type DescriptorFields = "all" | "id-only"

function parserPlugins(id: string): ("typescript" | "jsx")[] {
  const file = id.split("?")[0]!
  if (/\.[cm]?tsx$/.test(file)) return ["typescript", "jsx"]
  if (/\.[cm]?ts$/.test(file)) return ["typescript"]
  return ["jsx"]
}

async function importsMacros(code: string, packages: readonly string[], plugins: ReturnType<typeof parserPlugins>): Promise<boolean> {
  const lang = plugins.includes("typescript") ? plugins.includes("jsx") ? "tsx" : "ts" : "jsx"
  const { parseAst } = await import("vite")
  return parseAst(code, { lang }).body.some(statement =>
    statement.type === "ImportDeclaration" && statement.importKind !== "type" && packages.includes(statement.source.value)
    && statement.specifiers.some(specifier => specifier.type === "ImportSpecifier" && specifier.importKind !== "type"
      && macroNames.has(specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value)))
}

function splitRuntimeImports(packages: readonly string[], importBase: string, tNames: Set<string>) {
  return ({ types: t }: { types: typeof BabelTypes }): PluginObject => ({
    name: "vite-hub-i18n-split-imports",
    visitor: {
      ImportDeclaration(path) {
        if (!packages.includes(path.node.source.value) || path.node.importKind === "type") return
        for (const specifier of path.node.specifiers) {
          if (t.isImportSpecifier(specifier) && importedName(specifier.imported) === "t") tNames.add(specifier.local.name)
        }
        const runtime = path.node.specifiers.filter(specifier =>
          !t.isImportSpecifier(specifier) || !macroNames.has(importedName(specifier.imported)))
        if (runtime.length === 0) return
        path.node.specifiers = path.node.specifiers.filter(specifier => !runtime.includes(specifier))
        const moved = t.importDeclaration(runtime, t.stringLiteral(`${importBase}/runtime`))
        if (path.node.specifiers.length === 0) path.replaceWith(moved)
        else path.insertAfter(moved)
      },
    },
  })
}

type SourceMap = Exclude<InputOptions["inputSourceMap"], boolean | null | undefined>

function plainSourceMap(map: FileResult["map"]): SourceMap | undefined {
  if (!map) return undefined
  const { sourcesContent } = map
  return {
    ...map,
    file: map.file ?? "",
    names: [...map.names],
    sources: map.sources.map(source => source ?? ""),
    sourcesContent: sourcesContent?.every((content): content is string => content !== null) ? [...sourcesContent] : undefined,
  }
}

function importedName(node: BabelTypes.Identifier | BabelTypes.StringLiteral): string {
  return node.type === "Identifier" ? node.name : node.value
}

function bindVueMessages(importBase: string, tNames: ReadonlySet<string>) {
  return ({ types: t }: { types: typeof BabelTypes }): PluginObject => ({
    name: "vite-hub-i18n-vue-messages",
    visitor: {
      Program(path) {
        const useI18n = path.scope.generateUidIdentifier("useI18n")
        let bound = false
        for (const statement of path.get("body")) {
          if (!statement.isImportDeclaration() || statement.node.source.value !== `${importBase}/runtime`) continue
          for (const specifier of statement.node.specifiers) {
            if (!t.isImportSpecifier(specifier) || importedName(specifier.imported) !== "i18n") continue
            const binding = path.scope.getBinding(specifier.local.name)
            const instances = new Map<BabelTypes.Node, BabelTypes.Identifier>()
            for (const reference of binding?.referencePaths ?? []) {
              const setup = reference.findParent(parent => {
                if (parent.isObjectMethod()) return t.isIdentifier(parent.node.key, { name: "setup" })
                return (parent.isFunctionExpression() || parent.isArrowFunctionExpression())
                  && parent.parentPath.isObjectProperty() && t.isIdentifier(parent.parentPath.node.key, { name: "setup" })
              })
              if (!setup || !(setup.isObjectMethod() || setup.isFunctionExpression() || setup.isArrowFunctionExpression())) continue
              const body = setup.get("body")
              if (Array.isArray(body) || !body.isBlockStatement()) continue
              let instance = instances.get(setup.node)
              if (!instance) {
                instance = setup.scope.generateUidIdentifier("componentI18n")
                instances.set(setup.node, instance)
                body.unshiftContainer("body", t.variableDeclaration("const", [t.variableDeclarator(instance, t.callExpression(useI18n, []))]))
                bound = true
              }
              reference.replaceWith(t.cloneNode(instance))
            }
          }
        }
        if (bound) path.unshiftContainer("body", t.importDeclaration(
          [t.importSpecifier(useI18n, t.identifier("useI18n"))],
          t.stringLiteral(`${importBase}/vue`),
        ))
        for (const name of tNames) {
          if (path.scope.hasBinding(name) || !path.scope.hasGlobal(name)) continue
          path.unshiftContainer("body", t.importDeclaration(
            [t.importSpecifier(t.identifier(name), t.identifier("translateInTemplate"))],
            t.stringLiteral(`${importBase}/vue`),
          ))
        }
      },
    },
  })
}

/** Compile message macros to message IDs. Returns `undefined` for a file that does not import `vite-hub/i18n`. */
export async function transformMacros(
  code: string,
  id: string,
  config: LinguiConfigNormalized,
  importBase: string,
  descriptorFields: DescriptorFields,
  options?: { macroImportsOnly: boolean },
): Promise<{ code: string, map: SourceMap | null } | undefined> {
  const packages = config.macro.corePackage
  if (!packages.some(name => code.includes(`"${name}"`) || code.includes(`'${name}'`))) return undefined
  const filename = id.split("?")[0]!
  const syntax = parserPlugins(filename)
  if (options?.macroImportsOnly && !await importsMacros(code, packages, syntax)) return undefined
  const tNames = new Set<string>()
  const result = await transformAsync(code, {
    filename,
    babelrc: false,
    configFile: false,
    sourceMaps: true,
    ast: true,
    parserOpts: { sourceType: "module", plugins: syntax },
    plugins: [
      splitRuntimeImports(packages, importBase, tNames),
      [linguiMacroPlugin, { linguiConfig: config, descriptorFields }],
    ],
  })
  if (!result?.code) return undefined
  if (!filename.endsWith(".vue") || !result.ast) return { code: result.code, map: plainSourceMap(result.map) ?? null }
  const bound = await transformFromAstAsync(result.ast, result.code, {
    filename,
    babelrc: false,
    configFile: false,
    sourceMaps: true,
    inputSourceMap: plainSourceMap(result.map),
    plugins: [bindVueMessages(importBase, tNames)],
  })
  if (!bound?.code) return undefined
  return { code: bound.code, map: plainSourceMap(bound.map) ?? null }
}

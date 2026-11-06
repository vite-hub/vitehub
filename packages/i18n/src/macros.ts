import { transformAsync, transformFromAstAsync } from "@babel/core"
import linguiMacroPlugin from "@lingui/babel-plugin-lingui-macro"

import { macroNames } from "./lingui.ts"

import type { BabelFileResult, PluginObj, types as BabelTypes } from "@babel/core"
import type { LinguiConfigNormalized } from "@lingui/conf"

export type DescriptorFields = "all" | "id-only"

function parserPlugins(id: string): ("typescript" | "jsx")[] {
  const file = id.split("?")[0]!
  if (/\.[cm]?tsx$/.test(file)) return ["typescript", "jsx"]
  if (/\.[cm]?ts$/.test(file)) return ["typescript"]
  return ["jsx"]
}

/**
 * Lingui removes every import from a macro package. `vite-hub/i18n` also exports runtime functions such as
 * `getLocale`, so this moves them to `<importBase>/runtime` before Lingui runs.
 */
function splitRuntimeImports(packages: readonly string[], importBase: string, tNames: Set<string>) {
  return ({ types: t }: { types: typeof BabelTypes }): PluginObj => ({
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

function importedName(node: BabelTypes.Identifier | BabelTypes.StringLiteral): string {
  return node.type === "Identifier" ? node.name : node.value
}

/**
 * In `<script setup>`, Vue binds template ``t`...` `` to the `t` macro import. Lingui removes that import, but the
 * compiled template still calls `t(descriptor)`, so this binds the name to the template translator again.
 */
function bindTemplateT(importBase: string, tNames: ReadonlySet<string>) {
  return ({ types: t }: { types: typeof BabelTypes }): PluginObj => ({
    name: "vite-hub-i18n-template-t",
    visitor: {
      Program(path) {
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
): Promise<{ code: string, map: NonNullable<BabelFileResult["map"]> | null } | undefined> {
  const packages = config.macro.corePackage
  if (!packages.some(name => code.includes(`"${name}"`) || code.includes(`'${name}'`))) return undefined
  const filename = id.split("?")[0]!
  const tNames = new Set<string>()
  const result = await transformAsync(code, {
    filename,
    babelrc: false,
    configFile: false,
    sourceMaps: true,
    ast: true,
    parserOpts: { sourceType: "module", plugins: parserPlugins(id) },
    plugins: [
      splitRuntimeImports(packages, importBase, tNames),
      [linguiMacroPlugin, { linguiConfig: config, descriptorFields }],
    ],
  })
  if (!result?.code) return undefined
  if (!filename.endsWith(".vue") || tNames.size === 0 || !result.ast) return { code: result.code, map: result.map ?? null }
  const bound = await transformFromAstAsync(result.ast, result.code, {
    filename,
    babelrc: false,
    configFile: false,
    sourceMaps: true,
    inputSourceMap: result.map ?? undefined,
    plugins: [bindTemplateT(importBase, tNames)],
  })
  if (!bound?.code) return undefined
  return { code: bound.code, map: bound.map ?? null }
}

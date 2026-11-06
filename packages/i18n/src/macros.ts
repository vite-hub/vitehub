import { transformAsync } from "@babel/core"
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
function splitRuntimeImports(packages: readonly string[], runtimeModule: string) {
  return ({ types: t }: { types: typeof BabelTypes }): PluginObj => ({
    name: "vite-hub-i18n-split-imports",
    visitor: {
      ImportDeclaration(path) {
        if (!packages.includes(path.node.source.value) || path.node.importKind === "type") return
        const runtime = path.node.specifiers.filter(specifier =>
          !t.isImportSpecifier(specifier)
          || !macroNames.has(t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value))
        if (runtime.length === 0) return
        path.node.specifiers = path.node.specifiers.filter(specifier => !runtime.includes(specifier))
        const moved = t.importDeclaration(runtime, t.stringLiteral(runtimeModule))
        if (path.node.specifiers.length === 0) path.replaceWith(moved)
        else path.insertAfter(moved)
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
  const result = await transformAsync(code, {
    filename: id.split("?")[0],
    babelrc: false,
    configFile: false,
    sourceMaps: true,
    parserOpts: { sourceType: "module", plugins: parserPlugins(id) },
    plugins: [
      splitRuntimeImports(packages, `${importBase}/runtime`),
      [linguiMacroPlugin, { linguiConfig: config, descriptorFields }],
    ],
  })
  if (!result?.code) return undefined
  return { code: result.code, map: result.map ?? null }
}

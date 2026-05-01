import { pathToFileURL } from "node:url"

import { dirname, isAbsolute, normalize, relative } from "pathe"

function normalizeRelativeSpecifier(file: string) {
  const normalized = normalize(file)
  return normalized.startsWith(".") ? normalized : `./${normalized}`
}

function toPortableFileUrl(file: string) {
  const normalized = normalize(file)
  if (normalized.startsWith("//"))
    return `file:${encodeURI(normalized)}`
  if (/^[A-Za-z]:\//.test(normalized))
    return `file:///${encodeURI(normalized)}`

  return pathToFileURL(normalized).href
}

function toModuleSpecifier(file: string, importerFile?: string) {
  if (!importerFile) {
    return toPortableFileUrl(file)
  }

  const relativePath = relative(dirname(importerFile), file)
  if (isAbsolute(relativePath))
    return toPortableFileUrl(file)

  return normalizeRelativeSpecifier(relativePath)
}

export function serializeSchemaObject(schemaPaths: string[], variableName: string, includeExports = false, importerFile?: string) {
  if (!schemaPaths.length) {
    return [
      `const ${variableName} = {}`,
      "",
    ].join("\n")
  }

  const imports = schemaPaths.map((file, index) => `import * as ${variableName}_${index} from ${JSON.stringify(toModuleSpecifier(file, importerFile))};`)
  const exports = includeExports
    ? schemaPaths.map(file => `export * from ${JSON.stringify(toModuleSpecifier(file, importerFile))};`)
    : []
  const schemaRefs = schemaPaths.map((_, index) => `${variableName}_${index}`)

  return [
    ...imports,
    ...exports,
    `const ${variableName} = Object.assign({}, ${schemaRefs.join(", ")});`,
    "",
  ].join("\n")
}

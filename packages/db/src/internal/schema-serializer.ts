import { dirname, posix, relative, win32 } from "node:path"
import { pathToFileURL } from "node:url"

function isWindowsAbsolutePath(file: string) {
  return /^[A-Za-z]:[\\/]/.test(file) || /^\\\\/.test(file)
}

function normalizeRelativeSpecifier(file: string) {
  const normalized = file.replaceAll("\\", "/")
  return normalized.startsWith(".") ? normalized : `./${normalized}`
}

function toPortableFileUrl(file: string) {
  if (!isWindowsAbsolutePath(file)) {
    return pathToFileURL(file).href
  }

  const normalized = file.replaceAll("\\", "/")
  if (normalized.startsWith("//")) {
    return `file:${encodeURI(normalized)}`
  }

  return `file:///${encodeURI(normalized)}`
}

function toModuleSpecifier(file: string, importerFile?: string) {
  if (!importerFile) {
    return toPortableFileUrl(file)
  }

  const useWindowsPaths = isWindowsAbsolutePath(file) || isWindowsAbsolutePath(importerFile)
  const baseDir = useWindowsPaths ? win32.dirname(importerFile) : dirname(importerFile)
  const relativePath = useWindowsPaths ? win32.relative(baseDir, file) : relative(baseDir, file)

  return normalizeRelativeSpecifier(useWindowsPaths ? relativePath.split(win32.sep).join(posix.sep) : relativePath)
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

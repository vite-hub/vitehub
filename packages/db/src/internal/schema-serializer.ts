export function serializeSchemaObject(schemaPaths: string[], variableName: string, includeExports = false) {
  if (!schemaPaths.length) {
    return [
      `const ${variableName} = {}`,
      "",
    ].join("\n")
  }

  const imports = schemaPaths.map((file, index) => `import * as ${variableName}_${index} from ${JSON.stringify(file)};`)
  const exports = includeExports
    ? schemaPaths.map(file => `export * from ${JSON.stringify(file)};`)
    : []
  const schemaRefs = schemaPaths.map((_, index) => `${variableName}_${index}`)

  return [
    ...imports,
    ...exports,
    `const ${variableName} = Object.assign({}, ${schemaRefs.join(", ")});`,
    "",
  ].join("\n")
}

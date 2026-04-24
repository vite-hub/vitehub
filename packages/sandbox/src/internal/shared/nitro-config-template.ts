export function createNitroConfigTypeAugmentation(
  configKey: string,
  typeImport: string,
  typeName: string,
  enabledType = `boolean | ${typeName}`,
) {
  return [
    `declare module 'nitro/types' {`,
    `  interface NitroConfig {`,
    `    ${configKey}?: ${enabledType}`,
    `  }`,
    `  interface NitroRuntimeConfig {`,
    `    ${configKey}?: false | ${typeName}`,
    `  }`,
    `}`,
    ``,
    `export type { ${typeName} } from ${JSON.stringify(typeImport)}`,
    ``,
  ].join('\n')
}

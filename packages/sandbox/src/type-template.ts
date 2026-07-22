export interface SandboxTypeDefinition {
  handler: string
  hasPayloadType: boolean
  kind: 'definition' | 'package-entry'
  name: string
}

function createDefinitionContract(definition: SandboxTypeDefinition) {
  const module = `typeof import(${JSON.stringify(definition.handler)})`
  if (definition.kind === 'definition') {
    return `{ payload: Parameters<${module}['default']['run']>[0], result: Awaited<ReturnType<${module}['default']['run']>> }`
  }

  const fallbackPayload = definition.hasPayloadType
    ? `import(${JSON.stringify(definition.handler)}).SandboxPayload`
    : 'unknown'
  return `SandboxPackageContract<${module}['default'], ${fallbackPayload}>`
}

export function createSandboxTypeTemplateContents(definitions: SandboxTypeDefinition[]) {
  return [
    `declare module '#vitehub-sandbox-registry' {`,
    `  type SandboxPackageContract<TDefault, TFallbackPayload> = TDefault extends (...args: infer TArgs) => infer TResult`,
    `    ? { payload: TArgs extends [] ? unknown : TArgs[0], result: Awaited<TResult> }`,
    `    : { payload: TFallbackPayload, result: Awaited<TDefault> }`,
    `  export interface SandboxDefinitionModules {`,
    ...definitions.map(definition => `    ${JSON.stringify(definition.name)}: ${createDefinitionContract(definition)},`),
    `  }`,
    `  const sandboxRegistry: {`,
    ...definitions.map(definition => `    ${JSON.stringify(definition.name)}: () => Promise<{ default?: { bundle: import('@vite-hub/sandbox').SandboxDefinitionBundle, options?: import('@vite-hub/sandbox').SandboxDefinitionOptions } }>,`),
    `  }`,
    `  export default sandboxRegistry`,
    `}`,
    ``,
  ].join('\n')
}

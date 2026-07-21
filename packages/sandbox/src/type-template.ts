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

  const payload = definition.hasPayloadType
    ? `import(${JSON.stringify(definition.handler)}).SandboxPayload`
    : 'unknown'
  return `{ payload: ${payload}, result: Awaited<${module}['default']> }`
}

export function createSandboxTypeTemplateContents(definitions: SandboxTypeDefinition[]) {
  return [
    `declare module '#vitehub-sandbox-registry' {`,
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

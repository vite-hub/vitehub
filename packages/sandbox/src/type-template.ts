import type { ScannedDefinition } from './internal/shared/feature-definitions'
import { createNitroConfigTypeAugmentation } from './internal/shared/nitro-config-template'

export function createSandboxTypeTemplateContents(definitions: ScannedDefinition[]) {
  return [
    createNitroConfigTypeAugmentation('sandbox', '@vitehub/sandbox', 'AgentSandboxConfig'),
    `declare module '#vitehub-sandbox-registry' {`,
    `  export interface SandboxDefinitionModules {`,
    ...definitions.map(definition => `    ${JSON.stringify(definition.name)}: typeof import(${JSON.stringify(definition.handler)}),`),
    `  }`,
    `  const sandboxRegistry: {`,
    ...definitions.map(definition => `    ${JSON.stringify(definition.name)}: () => Promise<{ default?: { bundle: import('@vitehub/sandbox').SandboxDefinitionBundle, options?: import('@vitehub/sandbox').SandboxDefinitionOptions } }>,`),
    `  }`,
    `  export default sandboxRegistry`,
    `}`,
    ``,
  ].join('\n')
}

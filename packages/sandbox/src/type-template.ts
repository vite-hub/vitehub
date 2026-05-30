import type { ScannedDefinition } from './internal/shared/feature-definitions'
import { createNitroConfigTypeAugmentation } from './internal/shared/nitro-config-template'

export function createSandboxTypeTemplateContents(definitions: ScannedDefinition[]) {
  return [
    createNitroConfigTypeAugmentation('sandbox', '@vite-hub/sandbox', 'AgentSandboxConfig'),
    `declare module '#vitehub-sandbox-registry' {`,
    `  export interface SandboxDefinitionModules {`,
    ...definitions.map(definition => `    ${JSON.stringify(definition.name)}: typeof import(${JSON.stringify(definition.handler)}),`),
    `  }`,
    `  const sandboxRegistry: {`,
    ...definitions.map(definition => `    ${JSON.stringify(definition.name)}: () => Promise<{ default?: { bundle: import('@vite-hub/sandbox').SandboxDefinitionBundle, options?: import('@vite-hub/sandbox').SandboxDefinitionOptions } }>,`),
    `  }`,
    `  export default sandboxRegistry`,
    `}`,
    ``,
  ].join('\n')
}

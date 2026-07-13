import type { ScannedDefinition } from './internal/shared/feature-definitions'

export function createSandboxTypeTemplateContents(definitions: ScannedDefinition[], importBase = '@vite-hub/sandbox') {
  return [
    `declare module '#vitehub-sandbox-registry' {`,
    `  export interface SandboxDefinitionModules {`,
    ...definitions.map(definition => `    ${JSON.stringify(definition.name)}: typeof import(${JSON.stringify(definition.handler)}),`),
    `  }`,
    `  const sandboxRegistry: {`,
    ...definitions.map(definition => `    ${JSON.stringify(definition.name)}: () => Promise<{ default?: { bundle: import(${JSON.stringify(importBase)}).SandboxDefinitionBundle, options?: import(${JSON.stringify(importBase)}).SandboxDefinitionOptions } }>,`),
    `  }`,
    `  export default sandboxRegistry`,
    `}`,
    ``,
  ].join('\n')
}

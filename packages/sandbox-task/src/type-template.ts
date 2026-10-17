export interface SandboxTaskTypeDefinition {
  handler: string
  kind: 'definition' | 'package-entry'
  name: string
}

function createDefinitionContract(definition: SandboxTaskTypeDefinition) {
  const module = `typeof import(${JSON.stringify(definition.handler)})`
  if (definition.kind === 'definition') {
    return `{ payload: Parameters<${module}['default']['run']>[0], result: Awaited<ReturnType<${module}['default']['run']>> }`
  }

  return `SandboxTaskPackageContract<${module}['default']>`
}

export function createSandboxTaskTypeTemplateContents(definitions: SandboxTaskTypeDefinition[]) {
  return [
    `declare module '#vitehub-sandbox-task-registry' {`,
    `  type SandboxTaskPackageContract<TDefault extends (...args: any[]) => any> = TDefault extends (...args: infer TArgs) => infer TResult`,
    `    ? { payload: TArgs extends [] ? unknown : TArgs[0], result: Awaited<TResult> }`,
    `    : never`,
    `  export interface SandboxTaskDefinitionModules {`,
    ...definitions.map(definition => `    ${JSON.stringify(definition.name)}: ${createDefinitionContract(definition)},`),
    `  }`,
    `  const sandboxTaskRegistry: {`,
    ...definitions.map(definition => `    ${JSON.stringify(definition.name)}: () => Promise<{ default?: { bundle: import('@vite-hub/sandbox-task').SandboxTaskDefinitionBundle, options?: import('@vite-hub/sandbox-task').SandboxTaskDefinitionOptions } }>,`),
    `  }`,
    `  export default sandboxTaskRegistry`,
    `}`,
    ``,
  ].join('\n')
}

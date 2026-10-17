type SandboxTaskRegistry = Record<string, unknown>

export interface SandboxTaskDefinitionModules {}

function getRuntimeRegistry(): SandboxTaskRegistry {
  return (globalThis as typeof globalThis & {
    __vitehubSandboxTaskRegistry?: SandboxTaskRegistry
  }).__vitehubSandboxTaskRegistry || {}
}

const registry: SandboxTaskRegistry = new Proxy({} as SandboxTaskRegistry, {
  get(_target, key, receiver) {
    return Reflect.get(getRuntimeRegistry(), key, receiver)
  },
  has(_target, key) {
    return key in getRuntimeRegistry()
  },
  ownKeys() {
    return Reflect.ownKeys(getRuntimeRegistry())
  },
  getOwnPropertyDescriptor(_target, key) {
    return Object.getOwnPropertyDescriptor(getRuntimeRegistry(), key)
  },
})

export default registry

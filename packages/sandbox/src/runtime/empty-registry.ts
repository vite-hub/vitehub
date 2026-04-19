type SandboxRegistry = Record<string, unknown>

export interface SandboxDefinitionModules {}

function getRuntimeRegistry(): SandboxRegistry {
  return (globalThis as typeof globalThis & {
    __vitehubSandboxRegistry?: SandboxRegistry
  }).__vitehubSandboxRegistry || {}
}

const registry: SandboxRegistry = new Proxy({} as SandboxRegistry, {
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

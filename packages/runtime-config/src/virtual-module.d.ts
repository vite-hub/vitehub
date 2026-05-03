declare module "virtual:vitehub/runtime-config/build" {
  export const buildConfig: Record<string, unknown>
  export default buildConfig
}

declare module "virtual:vitehub/runtime-config/public-runtime" {
  export function getPublicRuntimeConfig(endpoint?: string): Promise<Record<string, unknown>>
}

declare module "#vitehub/runtime-config/server" {
  export function getRuntimeConfig(event?: unknown): {
    public: Record<string, unknown>
    server: Record<string, unknown>
  }
}

declare module "#vitehub/runtime-config/cloudflare" {
  export function getCloudflareRuntime(event: unknown): {
    bindings: Record<string, unknown>
    secrets: Record<string, unknown>
    vars: Record<string, unknown>
  }
}

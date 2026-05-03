declare module "virtual:@vitehub/env/build" {
  export const buildConfig: {
    public: Record<string, unknown>
  }
  export function useSafeBuildConfig(): typeof buildConfig
  export default buildConfig
}

declare module "virtual:@vitehub/env/public-runtime" {
  export function useSafePublicRuntimeConfig(endpoint?: string): Promise<Record<string, unknown>>
}

export {}

declare module "virtual:@vitehub/env/build" {
  export const buildConfig: {
    public: Record<string, unknown>
  }
  export function useSafeBuildConfig(): typeof buildConfig
  export default buildConfig
}

export {}

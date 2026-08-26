export const providerNodeHeapLimitMb = 1024

export function createProviderResourceEnvironment() {
  return {
    NODE_OPTIONS: `--max-old-space-size=${providerNodeHeapLimitMb}`,
  }
}

declare module "@nuxt/schema" {
  interface NuxtConfig {
    nitro?: import("nitro/types").NitroConfig
    queue?: import("../types.ts").QueueModuleOptions
  }

  interface NuxtOptions {
    nitro?: import("nitro/types").NitroConfig
    queue?: import("../types.ts").QueueModuleOptions
  }

  interface NuxtHooks {
    "nitro:config": (config: import("nitro/types").NitroConfig) => void | Promise<void>
  }
}

declare module "@nuxt/schema" {
  interface NuxtConfig {
    kv?: import("../types.ts").KVModuleOptions
    nitro?: import("nitro/types").NitroConfig
  }

  interface NuxtOptions {
    kv?: import("../types.ts").KVModuleOptions
    nitro?: import("nitro/types").NitroConfig
  }

  interface NuxtHooks {
    "nitro:config": (config: import("nitro/types").NitroConfig) => void | Promise<void>
  }
}

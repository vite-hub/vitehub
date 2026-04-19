declare module "@nuxt/schema" {
  interface NuxtConfig {
    blob?: import("../types.ts").BlobModuleOptions
    nitro?: import("nitro/types").NitroConfig
  }

  interface NuxtOptions {
    blob?: import("../types.ts").BlobModuleOptions
    nitro?: import("nitro/types").NitroConfig
  }

  interface NuxtHooks {
    "nitro:config": (config: import("nitro/types").NitroConfig) => void | Promise<void>
  }
}

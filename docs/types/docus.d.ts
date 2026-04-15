import "docus/app/types";
import "docus/modules/assistant";

declare global {
  const useRuntimeConfig: (event?: import("h3").H3Event) => import("nuxt/schema").RuntimeConfig;
}

declare module "nitropack/runtime/internal/config" {
  export function useRuntimeConfig(event?: import("h3").H3Event): import("nuxt/schema").RuntimeConfig;
}

import { hubDummyNuxt } from "@vitehub/dummy/nuxt";

export default defineNuxtConfig({
  runtimeConfig: {
    public: {
      dummy: hubDummyNuxt(),
    },
  },
});

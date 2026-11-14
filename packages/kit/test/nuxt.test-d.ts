import { defineNuxtConfig } from "nuxt/config";
import { it } from "vitest";

import kit from "@vite-hub/kit/nuxt";

it("accepts the imported module and the documented configuration key", () => {
  defineNuxtConfig({ modules: [[kit, { prefix: "Ui" }]] });
  defineNuxtConfig({ modules: ["@vite-hub/kit/nuxt"], viteHubKit: { prefix: "Ui" } });
  defineNuxtConfig({
    viteHubKit: {
      // @ts-expect-error The component prefix must be a string.
      prefix: 123,
    },
  });
});

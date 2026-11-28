import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
  compatibilityDate: "2026-11-01",
  css: ["~/assets/css/main.css"],
  components: [{ path: "~/components", extensions: [".vue"] }],
  vite: { plugins: [tailwindcss()] },
});

// One element for each utility. The check reads their computed colors. `?nuxt-ui` loads Nuxt UI and its color plugin,
// as the Console does; without it the page has only Tailwind, the kit tokens, and the kit bridge.
import { createApp, h } from "vue";

const nuxtUI = new URLSearchParams(location.search).has("nuxt-ui");
if (new URLSearchParams(location.search).get("theme") === "dark") document.documentElement.classList.add("dark");

if (nuxtUI) await import("./nuxt-ui.css");
else await import("./bridge.css");

const app = createApp({ render: () => h("main", { id: "fixture" }) });
if (nuxtUI) {
  const { default: ui } = await import("@nuxt/ui/vue-plugin");
  app.use(ui);
}
app.mount("#app");
Object.assign(window, { ready: true });

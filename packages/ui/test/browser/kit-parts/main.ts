// `?side=nuxt-ui` renders each case with the Nuxt UI component and theme.css, as the Console does today. `?side=kit`
// renders it as kit markup on the kit family, with no Nuxt UI. `?theme=dark` sets `.dark` on `<html>`.
import { addCollection } from "@iconify/vue";
import lucide from "@iconify-json/lucide/icons.json";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { createApp, h } from "vue";

import { cases } from "./cases.ts";

const params = new URLSearchParams(location.search);
const side = params.get("side") === "kit" ? "kit" : "nuxt-ui";
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");

addCollection(lucide);
if (side === "nuxt-ui") await import("./nuxt-ui.css");
else await import("./kit.css");
const { render } = side === "nuxt-ui" ? await import("./nuxt-ui.ts") : await import("./kit.ts");

const blocks = new Set(["alert", "empty", "card"]);
const app = createApp({
  render: () => h("main", { class: "cases" }, cases.map(item =>
    h("div", { class: "case", "data-case": item.id, "data-part": item.part, "data-block": blocks.has(item.part) ? "" : undefined }, [render(item)]))),
});
if (side === "nuxt-ui") {
  const { default: ui } = await import("@nuxt/ui/vue-plugin");
  app.use(ui);
}
app.mount("#app");
await document.fonts.ready;
Object.assign(window, { ready: true });

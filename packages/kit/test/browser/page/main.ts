import { createApp } from "vue";
import App from "./App.vue";

const params = new URLSearchParams(location.search);

const styles = params.get("styles");
if (styles === "scoped") await import("./scoped.css");
else if (styles === "none") await import("./none.css");
else await import("./main.css");
const app = document.querySelector<HTMLElement>("#app")!;
if (styles) app.classList.add("ui-sdk");

const theme = params.get("theme");
if (theme === "dark") document.documentElement.classList.add("dark");
if (theme === "data-dark") document.documentElement.dataset.theme = "dark";
if (theme === "root-dark") app.classList.add("dark");

if (params.has("outside")) {
  const outside = document.createElement("div");
  outside.id = "outside";
  outside.innerHTML = `
    <button type="button" data-slot="button"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M5 12h14"/></svg>Nuxt UI</button>
    <span data-slot="avatar">MG</span>
    <input data-slot="input" placeholder="Search">
    <label data-slot="label">Label</label>
    <a href="#outside">Link</a>
    <kbd>K</kbd>
    <code>code</code>
    <hr>
    <details><summary>Summary</summary></details>
    <span data-slot="badge" hidden>Hidden</span>`;
  document.body.prepend(outside);
}

createApp(App).mount(app);

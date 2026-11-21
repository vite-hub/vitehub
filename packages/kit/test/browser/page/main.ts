import { createApp } from "vue";
import App from "./App.vue";

const params = new URLSearchParams(location.search);

// `?styles=scoped` loads `default.scoped.css` and renders the parts in a `.ui-sdk` root, as a page next to Nuxt UI does.
// `?styles=none` is the same page without the family. Without the parameter, the page loads `default.css`.
const styles = params.get("styles");
if (styles === "scoped") await import("./scoped.css");
else if (styles === "none") await import("./none.css");
else await import("./main.css");
const app = document.querySelector<HTMLElement>("#app")!;
if (styles) app.classList.add("ui-sdk");

// `.dark` and `[data-theme="dark"]` both switch the tokens. The check uses one or the other, on the page or on the scope root.
const theme = params.get("theme");
if (theme === "dark") document.documentElement.classList.add("dark");
if (theme === "data-dark") document.documentElement.dataset.theme = "dark";
if (theme === "root-dark") app.classList.add("dark");

// `?outside` adds elements that Nuxt UI renders, outside the scope root: no rule of the scoped family may reach them.
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

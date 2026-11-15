import { createApp } from "vue";
import "./main.css";
import App from "./App.vue";

const params = new URLSearchParams(location.search);
// `.dark` and `[data-theme="dark"]` both switch the tokens. The check uses one or the other.
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
if (params.get("theme") === "data-dark") document.documentElement.dataset.theme = "dark";

createApp(App).mount("#app");

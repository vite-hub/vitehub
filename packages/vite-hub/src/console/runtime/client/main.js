import "./styles.css";
import "@vite-hub/ui/styles.css";

import ui from "@nuxt/ui/vue-plugin";
import { createViteHubUI } from "@vite-hub/ui";
import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";

import ConsoleApp from "../components/console-app.vue";
import App from "./app.vue";

const router = createRouter({
  history: createWebHistory("/_vitehub/"),
  routes: [
    { path: "/", redirect: { name: "vitehub-console-agents" } },
    {
      component: ConsoleApp,
      name: "vitehub-console-agents",
      path: "/agents",
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        apiBase: "/api/_vitehub/console/invocations",
        searchBase: "/api/_vitehub/console/search",
      },
    },
    {
      component: ConsoleApp,
      name: "vitehub-console-agent",
      path: "/agents/:agent",
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        apiBase: "/api/_vitehub/console/invocations",
        searchBase: "/api/_vitehub/console/search",
      },
    },
    {
      component: ConsoleApp,
      name: "vitehub-console-invocation",
      path: "/agents/:agent/invocations/:invocation",
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        apiBase: "/api/_vitehub/console/invocations",
        searchBase: "/api/_vitehub/console/search",
      },
    },
  ],
});

document.title = "Agents · ViteHub Console";
createApp(App).use(router).use(ui).use(createViteHubUI()).mount("#app");

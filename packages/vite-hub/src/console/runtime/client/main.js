import "./styles.css";
import "@vite-hub/ui/styles.css";

import ui from "@nuxt/ui/vue-plugin";
import { createViteHubUI } from "@vite-hub/ui";
import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";

import ConsoleApp from "../components/console-app.vue";
import ConsoleHome from "../components/console-home.vue";
import ConsoleKv from "../components/console-kv.vue";
import ConsoleDefinitions from "../components/console-definitions.vue";
import { isConsoleSectionId } from "../sections";
import App from "./app.vue";
import { requestConsole } from "./request";

const sectionsBase = "/api/_vitehub/console/sections";

const router = createRouter({
  history: createWebHistory("/_vitehub/"),
  routes: [
    {
      component: ConsoleHome,
      name: "vitehub-console",
      path: "/",
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        kvBase: "/api/_vitehub/console/kv",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
      },
      meta: { title: "ViteHub Console" },
    },
    {
      component: ConsoleApp,
      name: "vitehub-console-agents",
      path: "/agents",
      meta: { consoleSection: "agents", title: "Agents · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        apiBase: "/api/_vitehub/console/invocations",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleApp,
      name: "vitehub-console-agent",
      path: "/agents/:agent",
      meta: { consoleSection: "agents", title: "Agents · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        apiBase: "/api/_vitehub/console/invocations",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleApp,
      name: "vitehub-console-invocation",
      path: "/agents/:agent/invocations/:invocation",
      meta: { consoleSection: "agents", title: "Agents · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        apiBase: "/api/_vitehub/console/invocations",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleKv,
      name: "vitehub-console-kv",
      path: "/kv",
      meta: { consoleSection: "kv", title: "KV · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        kvBase: "/api/_vitehub/console/kv",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleDefinitions,
      name: "vitehub-console-workflows",
      path: "/workflows",
      meta: { consoleSection: "workflows", title: "Workflows · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        definitionsBase: "/api/_vitehub/console/definitions",
        searchBase: "/api/_vitehub/console/search",
        section: "workflows",
        sectionsBase,
      },
    },
    {
      component: ConsoleDefinitions,
      name: "vitehub-console-queues",
      path: "/queues",
      meta: { consoleSection: "queues", title: "Queues · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        definitionsBase: "/api/_vitehub/console/definitions",
        searchBase: "/api/_vitehub/console/search",
        section: "queues",
        sectionsBase,
      },
    },
  ],
});

let installedSections;

async function loadSections() {
  if (installedSections) return await installedSections;
  installedSections = requestConsole(sectionsBase)
    .then((value) =>
      Array.isArray(value?.sections) ? value.sections.filter(isConsoleSectionId) : [],
    )
    .catch(() => undefined);
  return await installedSections;
}

router.beforeEach(async (to) => {
  const section = to.meta.consoleSection;
  if (!isConsoleSectionId(section)) return;
  const installed = await loadSections();
  if (installed && !installed.includes(section)) return { name: "vitehub-console" };
});

router.afterEach((to) => {
  document.title = String(to.meta.title ?? "ViteHub Console");
});

createApp(App).use(router).use(ui).use(createViteHubUI()).mount("#app");

import "./styles.css";
import "@vite-hub/ui/styles.css";

import ui from "@nuxt/ui/vue-plugin";
import { createViteHubUI } from "@vite-hub/ui";
import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";

import ConsoleApp from "../components/console-app.vue";
import ConsoleHome from "../components/console-home.vue";
import ConsoleBlob from "../components/console-blob.vue";
import ConsoleKv from "../components/console-kv.vue";
import ConsoleDefinitions from "../components/console-definitions.vue";
import { isConsoleSectionId } from "../sections";
import App from "./app.vue";
import { createConsoleSectionLoader } from "./sections";

const sectionsBase = "/api/_vitehub/console/sections";
const hostBase = "";

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
        hostBase,
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
        usageBase: "/api/_vitehub/console/usage",
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
        hostBase,
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
        usageBase: "/api/_vitehub/console/usage",
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
        hostBase,
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleBlob,
      name: "vitehub-console-blob",
      path: "/blob",
      meta: { consoleSection: "blob", title: "Blob · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        blobBase: "/api/_vitehub/console/blob",
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
      component: ConsoleApp,
      name: "vitehub-console-usage",
      path: "/usage",
      meta: { consoleSection: "usage", title: "Usage · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        apiBase: "/api/_vitehub/console/invocations",
        hostBase,
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
        usageBase: "/api/_vitehub/console/usage",
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
    {
      component: ConsoleDefinitions,
      name: "vitehub-console-schedules",
      path: "/schedules",
      meta: { consoleSection: "schedules", title: "Schedules · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        definitionsBase: "/api/_vitehub/console/definitions",
        searchBase: "/api/_vitehub/console/search",
        section: "schedules",
        sectionsBase,
      },
    },
  ],
});

const loadSections = createConsoleSectionLoader(sectionsBase);

router.beforeEach(async (to) => {
  const section = to.meta.consoleSection;
  if (!isConsoleSectionId(section)) return;
  const installed = await loadSections();
  if (installed && !installed.includes(section)) return { name: "vitehub-console" };
});

router.afterEach((to) => {
  document.title = String(to.meta.title ?? "ViteHub Console");
});
createApp(App)
  .use(router)
  .use(ui, { router: () => router.currentRoute.value })
  .use(createViteHubUI())
  .mount("#app");

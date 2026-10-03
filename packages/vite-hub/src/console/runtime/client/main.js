import ConsoleConnections from "../components/console-connections.vue";
import ConsoleEnv from "../components/console-env.vue";
import "./styles.css";
import "@vite-hub/ui/styles.css";

import ui from "@nuxt/ui/vue-plugin";
import { createViteHubUI } from "@vite-hub/ui";
import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";

import ConsoleApp from "../components/console-app.vue";
import ConsoleBlob from "../components/console-blob.vue";
import ConsoleDatabase from "../components/console-database.vue";
import ConsoleDefinitions from "../components/console-definitions.vue";
import ConsoleHome from "../components/console-home.vue";
import ConsoleKv from "../components/console-kv.vue";
import {
  consoleDatabaseSchemaPath,
  consoleDatabaseTablePath,
  consoleDatabasesSchemaPath,
  consoleDatabasesTablePath,
} from "../console-route";
import { consoleSectionRouteName, isConsoleSectionId } from "../sections";
import App from "./app.vue";
import { createConsoleSectionLoader, loadConsoleNavigation, subscribeConsoleNavigation } from "./sections";

const sectionsBase = "/api/_vitehub/console/sections";
const capabilitiesBase = "/api/_vitehub/console/invocation-capabilities";
const hostBase = "";

const router = createRouter({
  history: createWebHistory("/_vitehub/"),
  routes: [
    { component: ConsoleConnections, name: "vitehub-console-connections", path: "/connections", meta: { consoleSection: "connections", title: "Connections · ViteHub Console" }, props: { agentsBase: "/api/_vitehub/console/agents", definitionsBase: "/api/_vitehub/console/definitions", kvBase: "/api/_vitehub/console/kv", managementBase: "/_vitehub/connections", searchBase: "/api/_vitehub/console/search", sectionsBase } },
    { component: ConsoleEnv, name: "vitehub-console-env", path: "/env", meta: { consoleSection: "env", title: "Env · ViteHub Console" }, props: { agentsBase: "/api/_vitehub/console/agents", definitionsBase: "/api/_vitehub/console/definitions", kvBase: "/api/_vitehub/console/kv", envBase: "/api/_vitehub/console/env", managementBase: "/_vitehub/env/manage", searchBase: "/api/_vitehub/console/search", sectionsBase } },
    {
      component: ConsoleHome,
      name: "vitehub-console",
      path: "/",
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        definitionsBase: "/api/_vitehub/console/definitions",
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
        capabilitiesBase,
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
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
        capabilitiesBase,
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
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
        capabilitiesBase,
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
        hostBase,
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
        usageBase: "/api/_vitehub/console/usage",
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
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleDatabase,
      name: "vitehub-console-database-schema",
      path: consoleDatabaseSchemaPath,
      meta: { consoleSection: "database", title: "Schema · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        databaseBase: "/api/_vitehub/console/database",
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
        view: "schema",
      },
    },
    {
      component: ConsoleDatabase,
      name: "vitehub-console-database",
      path: consoleDatabaseTablePath,
      meta: { consoleSection: "database", title: "Database · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        databaseBase: "/api/_vitehub/console/database",
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
        view: "data",
      },
    },
    {
      component: ConsoleKv,
      name: "vitehub-console-kv",
      path: "/kv",
      meta: { consoleSection: "kv", title: "KV · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        definitionsBase: "/api/_vitehub/console/definitions",
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
        capabilitiesBase,
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
        hostBase,
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
        usageBase: "/api/_vitehub/console/usage",
      },
    },
    {
      component: ConsoleDatabase,
      name: "vitehub-console-databases-schema",
      path: consoleDatabasesSchemaPath,
      meta: { consoleSection: "databases", title: "Schema · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        databaseBase: "/api/_vitehub/console/database",
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
        searchBase: "/api/_vitehub/console/search",
        section: "databases",
        sectionsBase,
        view: "schema",
      },
    },
    {
      component: ConsoleDatabase,
      name: "vitehub-console-databases",
      path: consoleDatabasesTablePath,
      meta: { consoleSection: "databases", title: "Databases · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        databaseBase: "/api/_vitehub/console/database",
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
        searchBase: "/api/_vitehub/console/search",
        section: "databases",
        sectionsBase,
        view: "data",
      },
    },
  ],
});

const loadSections = createConsoleSectionLoader(sectionsBase);

/** Adds one route for each installed section that an owner package contributes. */
function addContributedRoutes(navigation) {
  for (const section of navigation.sections) {
    const details = navigation.contributions[section];
    const name = consoleSectionRouteName(section);
    if (!details || router.hasRoute(name)) continue;
    router.addRoute({
      component: ConsoleDefinitions,
      name,
      path: `/${section}`,
      meta: { consoleSection: section, title: `${details.label} · ViteHub Console` },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        definitionsBase: "/api/_vitehub/console/definitions",
        details,
        kvBase: "/api/_vitehub/console/kv",
        scheduleRunBase: "/api/_vitehub/console/schedule-run",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
      },
    });
  }
}
subscribeConsoleNavigation(sectionsBase, addContributedRoutes);

const preferredColorScheme = window.matchMedia("(prefers-color-scheme: dark)");
const applyPreferredColorScheme = ({ matches }) => {
  document.documentElement.classList.toggle("dark", matches);
};
applyPreferredColorScheme(preferredColorScheme);
preferredColorScheme.addEventListener("change", applyPreferredColorScheme);

router.beforeEach(async (to) => {
  if (to.matched.length === 0) {
    // Contributed section routes exist only after the navigation response arrives.
    const navigation = await loadConsoleNavigation(sectionsBase);
    if (navigation) addContributedRoutes(navigation);
    return router.resolve(to.fullPath).matched.length > 0
      ? to.fullPath
      : { name: "vitehub-console" };
  }
  const section = to.meta.consoleSection;
  if (!isConsoleSectionId(section)) return;
  void loadSections().then((installed) => {
    if (
      installed &&
      !installed.includes(section) &&
      router.currentRoute.value.fullPath === to.fullPath
    ) {
      void router.replace({ name: "vitehub-console" });
    }
  });
});

router.afterEach((to) => {
  document.title = String(to.meta.title ?? "ViteHub Console");
});
createApp(App)
  .use(router)
  .use(ui, { router: () => router.currentRoute.value })
  .use(createViteHubUI())
  .mount("#app");

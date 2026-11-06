import "./styles.css";
import "@vite-hub/ui/styles.css";

import ui from "@nuxt/ui/vue-plugin";
import { createViteHubUI } from "@vite-hub/ui";
import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";

const ConsoleApp = () => import("../components/console-app.vue");
const ConsoleAuth = () => import("../components/console-auth.vue");
const ConsoleBlob = () => import("../components/console-blob.vue");
const ConsoleChannels = () => import("../components/console-channels.vue");
const ConsoleConnect = () => import("../components/console-connect.vue");
const ConsoleConnections = () => import("../components/console-connections.vue");
const ConsoleDatabase = () => import("../components/console-database.vue");
const ConsoleDefinitions = () => import("../components/console-definitions.vue");
const ConsoleOperationView = () => import("../components/console-operation-view.vue");
const ConsoleEnv = () => import("../components/console-env.vue");
const ConsoleHome = () => import("../components/console-home.vue");
const ConsoleLogs = () => import("../components/console-logs.vue");
const ConsoleKv = () => import("../components/console-kv.vue");
const ConsoleMcpClient = () => import("../components/console-mcp-client.vue");
const ConsoleMcpCallback = () => import("../components/console-mcp-callback.vue");
const ConsoleSkills = () => import("../components/console-skills.vue");
import {
  consoleDatabasesSchemaPath,
  consoleDatabasesTablePath,
  consoleMountBase,
  consoleMountPath,
} from "../console-route";
import { consoleSectionRouteName, describeConsoleSectionRoutes, isConsoleSectionId } from "../sections";
import App from "./app.vue";
import { consoleAppearanceKey, consoleDarkSchemeQuery, startConsoleAppearance } from "./appearance";
import { addViteHubIcons, deferLucideIcons } from "./icons";
import { consoleProjectReady, startConsoleProjects } from "./project-session";
import { memoryProjectStorage } from "./projects";
import { createConsoleSectionLoader, loadConsoleNavigation, subscribeConsoleNavigation } from "./sections";

// The hosted build marks its static page. There the Console opens the projects that this browser linked. Otherwise the
// app serves the page, and the Console reads that app. The Console API paths below are app paths; `projectUrl()` adds
// the origin and the mount of the project.
const hosted = document.querySelector('meta[name="vitehub-console-mode"]')?.getAttribute("content") === "hosted";
const hostBase = hosted ? "" : consoleMountBase(window.location.pathname);
const consoleBase = hosted ? import.meta.env.BASE_URL : consoleMountPath(hostBase, "/_vitehub/");

function projectStorage() {
  try {
    const storage = window.localStorage;
    storage.getItem("vitehub-console:projects");
    return storage;
  } catch {
    // A browser that blocks storage keeps the projects for this tab only.
    return memoryProjectStorage();
  }
}

startConsoleProjects({
  base: hostBase,
  home: consoleBase,
  mode: hosted ? "hosted" : "embedded",
  navigate: (url) => window.location.assign(url),
  pageOrigin: window.location.origin,
  storage: projectStorage(),
});
const sectionsBase = "/api/_vitehub/console/sections";
const capabilitiesBase = "/api/_vitehub/console/invocation-capabilities";

const router = createRouter({
  history: createWebHistory(consoleBase),
  routes: [
    { component: ConsoleLogs, name: "vitehub-console-logs", path: "/logs", meta: { consoleSection: "logs", title: "Logs · ViteHub Console" }, props: { logsBase: "/api/_vitehub/console/logs", sectionsBase } },
    { component: ConsoleEnv, name: "vitehub-console-env", path: "/env", meta: { consoleSection: "env", title: "Env · ViteHub Console" }, props: { agentsBase: "/api/_vitehub/console/agents", definitionsBase: "/api/_vitehub/console/definitions", kvBase: "/api/_vitehub/console/kv", envBase: "/api/_vitehub/console/env", managementBase: "/_vitehub/env/manage", searchBase: "/api/_vitehub/console/search", sectionsBase } },
    {
      component: ConsoleConnections,
      name: "vitehub-console-connections",
      path: "/connections",
      meta: { consoleSection: "connections", title: "Connections · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
        managementBase: "/_vitehub/connections",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleMcpClient,
      name: "vitehub-console-mcp-client",
      path: "/mcp-client",
      meta: { consoleSection: "mcp-client", title: "MCP client · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
      },
    },
    // Authorization servers send the browser here after an MCP sign-in (`consoleMcpCallbackPath`).
    {
      component: ConsoleMcpCallback,
      name: "vitehub-console-mcp-client-callback",
      path: "/mcp-client/callback",
      meta: { consoleSection: "mcp-client", title: "MCP client · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
      },
    },
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
      component: ConsoleConnect,
      name: "vitehub-console-connect",
      path: "/connect",
      meta: { title: "Connect an agent · ViteHub Console" },
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
      name: "vitehub-console-agents",
      path: "/agents",
      meta: { consoleSection: "agents", title: "Agents · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        apiBase: "/api/_vitehub/console/invocations",
        capabilitiesBase,
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
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
      component: ConsoleSkills,
      name: "vitehub-console-skills",
      path: "/skills",
      meta: { consoleSection: "skills", title: "Skills · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
        searchBase: "/api/_vitehub/console/search",
        skillsBase: "/api/_vitehub/console/skills",
        sectionsBase,
      },
    },
    {
      component: ConsoleChannels,
      name: "vitehub-console-channels",
      path: "/channels",
      meta: { consoleSection: "channels", title: "Channels · ViteHub Console" },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        channelsBase: "/api/_vitehub/console/channels",
        definitionsBase: "/api/_vitehub/console/definitions",
        kvBase: "/api/_vitehub/console/kv",
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
        view: "data",
        sectionsBase,
      },
    },
  ],
});

const loadSections = createConsoleSectionLoader(sectionsBase);

// The document editor loads Tiptap and the Comark kit, so it is a separate chunk.
const ConsoleDocuments = () => import("../components/console-documents.vue");

/** Adds one route for each installed section that an owner package contributes. */
function addContributedRoutes(navigation) {
  for (const section of navigation.sections) {
    const details = navigation.contributions[section];
    const name = consoleSectionRouteName(section);
    if (!details || router.hasRoute(name)) continue;
    if (details.view.kind === "auth-management") {
      router.addRoute({
        component: ConsoleAuth,
        name,
        path: "/auth/:page(overview|users|sessions|organizations|agents|activity)?",
        meta: { consoleSection: section, title: "Auth · ViteHub Console" },
        props: { sectionsBase, managementBase: "/_vitehub/auth/manage" },
      });
      continue;
    }
    if (details.view.kind === "document-editor") {
      const props = {
        agentsBase: "/api/_vitehub/console/agents",
        definitionsBase: "/api/_vitehub/console/definitions",
        details,
        documentsBase: "/api/_vitehub/console/documents",
        kvBase: "/api/_vitehub/console/kv",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
      };
      // The main view and every page render the same component, so the section sidebar stays mounted between them.
      for (const route of describeConsoleSectionRoutes(details)) {
        if (route.redirect) {
          router.addRoute({ name: route.name, path: route.path, redirect: route.redirect });
          continue;
        }
        const page = details.pages?.find(entry => entry.id === route.page);
        router.addRoute({
          component: ConsoleDocuments,
          name: route.name,
          path: route.path,
          meta: { consolePage: route.page, consoleSection: section, title: `${page ? `${page.label} · ` : ""}${details.label} · ViteHub Console` },
          props,
        });
      }
      continue;
    }
    if (details.view.kind === "operation-view") {
      router.addRoute({
        component: ConsoleOperationView,
        name,
        path: `/${section}`,
        meta: { consoleSection: section, title: `${details.label} · ViteHub Console` },
        props: { definitionsBase: "/api/_vitehub/console/definitions", details, sectionsBase },
      });
      continue;
    }
    router.addRoute({
      component: ConsoleDefinitions,
      name,
      path: `/${section}`,
      meta: { consoleSection: section, title: `${details.label} · ViteHub Console` },
      props: {
        agentsBase: "/api/_vitehub/console/agents",
        definitionsBase: "/api/_vitehub/console/definitions",
        details,
        ...(section === "rate-limits" ? { rateLimitBase: "/api/_vitehub/console/rate-limit" } : {}),
        ...(section === "schedules" ? { scheduleRunBase: "/api/_vitehub/console/schedule-run" } : {}),
        ...(section === "workflows" ? { workflowBase: "/api/_vitehub/console/workflow" } : {}),
        kvBase: "/api/_vitehub/console/kv",
        searchBase: "/api/_vitehub/console/search",
        sectionsBase,
      },
    });
  }
}
subscribeConsoleNavigation(sectionsBase, addContributedRoutes);

// Apply the stored appearance before the first render so the page does not flash the other scheme.
const appearance = startConsoleAppearance({
  query: window.matchMedia(consoleDarkSchemeQuery),
  root: document.documentElement,
  themeColorDocument: document,
});

router.beforeEach(async (to) => {
  if (window.parent !== window && to.query.embed !== "1") return { ...to, query: { ...to.query, embed: "1" } };
  // The first page waits until the project opens, so its requests carry the token and go to the linked project.
  await consoleProjectReady();
  if (to.matched.length === 0) {
    // Contributed section routes exist only after the navigation response arrives.
    const navigation = await loadConsoleNavigation(sectionsBase);
    if (navigation) addContributedRoutes(navigation);
    return router.resolve(to.fullPath).matched.length > 0 ? to.fullPath : { name: "vitehub-console" };
  }
});

router.afterEach((to, _from, failure) => {
  document.title = String(to.meta.title ?? "ViteHub Console");
  const section = to.meta.consoleSection;
  if (failure || !isConsoleSectionId(section)) return;
  // The page shows at once. A section that this app does not have falls back to the Overview when the sections arrive.
  // This runs after the navigation, so a sections answer that arrives before the page's code loads still finds it.
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
addViteHubIcons();
deferLucideIcons();
createApp(App, { sectionsBase })
  .provide(consoleAppearanceKey, appearance)
  .use(router)
  .use(ui, { router: () => router.currentRoute.value })
  .use(createViteHubUI())
  .mount("#app");

// Only the same-origin parent can navigate this editor; Vue Router runs its save/leave guards.
if (window.parent !== window) {
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.defaultPrevented) window.parent.postMessage({ type: "vitehub:minimize" }, location.origin);
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    const data = event.data;
    if (data?.type === "vitehub:navigate" && typeof data.path === "string" && data.path.startsWith("/") && !data.path.startsWith("//") && !data.path.includes("\\")) void router.push(data.path);
  });
  router.afterEach((to, _from, failure) => {
    if (!failure) window.parent.postMessage({ type: "vitehub:route", path: to.fullPath }, location.origin);
  });
  void router.isReady().then(() => window.parent.postMessage({ type: "vitehub:ready" }, location.origin));
}

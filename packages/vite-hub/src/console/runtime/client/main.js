import "./styles.css";
import "@vite-hub/ui/styles.css";

import ui from "@nuxt/ui/vue-plugin";
import { createViteHubUI } from "@vite-hub/ui";
import { vitehubTheme } from "@vite-hub/ui/theme";
import { createApp, watch } from "vue";
import { createRouter, createWebHistory } from "vue-router";

const ConsoleApp = () => import("../components/console-app.vue");
const ConsoleAppSettings = () => import("../components/console-app-settings.vue");
const ConsoleAuth = () => import("../components/console-auth.vue");
const ConsoleBlob = () => import("../components/console-blob.vue");
const ConsoleCache = () => import("../components/console-cache.vue");
const ConsoleChannels = () => import("../components/console-channels.vue");
const ConsoleDatabase = () => import("../components/console-database.vue");
const ConsoleDefinitions = () => import("../components/console-definitions.vue");
const ConsoleOperationView = () => import("../components/console-operation-view.vue");
const ConsoleEnv = () => import("../components/console-env.vue");
const ConsoleHome = () => import("../components/console-home.vue");
const ConsoleLogs = () => import("../components/console-logs.vue");
const ConsoleKv = () => import("../components/console-kv.vue");
const ConsoleSite = () => import("../components/console-site.vue");
const ConsoleMcpClient = () => import("../components/console-mcp-client.vue");
const ConsoleMcpCallback = () => import("../components/console-mcp-callback.vue");
const ConsoleSkills = () => import("../components/console-skills.vue");
const ConsoleSetup = () => import("../components/console-setup.vue");
const ConsoleWebhooks = () => import("../components/console-webhooks.vue");
import {
  consoleDatabasesSchemaPath,
  consoleDatabasesTablePath,
  consoleMountBase,
  consoleMountPath,
} from "../console-route";
import { consoleSectionRouteName, describeConsoleSectionRoutes, isConsoleSectionId } from "../sections";
import App from "./app.vue";
import { consoleAccountViewsKey } from "./account-views";
import { browserConsoleChunkHost, createConsoleChunkRecovery, forgetConsoleChunkReload, isConsoleChunkError } from "./chunk-recovery";
import { consoleAppearanceKey, consoleDarkSchemeQuery, startConsoleAppearance } from "./appearance";
import { addViteHubIcons, deferLucideIcons } from "./icons";
import { loadConsolePageTools } from "./page-tools";
import { consoleProjectReady, openConsoleProject, openConsoleSite, startConsoleAccount, startConsoleProjects, useConsoleProjects } from "./project-session";
import { memoryProjectStorage } from "./projects";
import { consolePendingSectionRoute, consoleSectionsPath, createConsoleSectionLoader, isConsoleSectionRevoked, loadConsoleNavigation, resolveConsoleSectionDeepLink, subscribeConsoleNavigation } from "./sections";

// The Console app marks its page `account`: people sign in, and the Console server signs and forwards the calls of
// their team's projects. Otherwise the page and the app share one origin, as in the Console playground, and the Console
// reads that app. The Console API paths below are app paths; `projectUrl()` adds the origin and the mount of the project.
const pageMode = document.querySelector('meta[name="vitehub-console-mode"]')?.getAttribute("content");
const account = pageMode === "account";
const hostBase = account ? "" : consoleMountBase(window.location.pathname);
const consoleBase = account ? import.meta.env.BASE_URL : consoleMountPath(hostBase, "/_vitehub/");

// Apply the stored appearance before the first render so the page does not flash the other scheme. An `account`
// Console waits for its account before it renders, so the scheme comes first.
const appearance = startConsoleAppearance({
  query: window.matchMedia(consoleDarkSchemeQuery),
  root: document.documentElement,
  themeColorDocument: document,
});

/** @type {import("./account-views").ConsoleAccountViews} */
const accountViews = {};
// The app opened in the same task from the answers that the device kept from the last visit.
let openedAtOnce = false;

if (account) {
  // The Console server drew the first view of the visit from its path and cookies (`@vite-hub/console`, src/page.ts).
  const boot = document.querySelector("[data-vitehub-boot]")?.getAttribute("data-vitehub-boot") ?? undefined;
  // The code of that view loads together with the account, and the gate renders it in its first frame.
  const view = (name, load) => load().then(module => { accountViews[name] = module.default; }, () => undefined);
  const views = boot === "shell"
    ? [
        view("shell", () => import("../components/console-account-shell.vue")),
        // A page with its own data starts that load too, so the first paint after the frame is the whole page.
        ...(/^\/team\/?$/.test(window.location.pathname) ? [view("team", () => import("../components/console-account-team.vue")), import("./account").then(module => module.earlyConsoleTeam.start(), () => undefined)] : []),
        ...(/^\/team-settings\/?$/.test(window.location.pathname) ? [view("teamSettings", () => import("../components/console-account-team-settings.vue"))] : []),
        ...(/^\/env\/?$/.test(window.location.pathname) ? [view("env", () => import("../components/console-account-env.vue"))] : []),
        ...(/^\/settings\/?$/.test(window.location.pathname) ? [view("settings", () => import("../components/console-account-settings.vue")), import("./account").then(module => module.earlyConsoleSignInState.start(), () => undefined)] : []),
      ]
    : boot === "sign-in" || boot === "invite"
      ? [view("signIn", () => import("../components/console-account-sign-in.vue")), import("./account").then(module => module.loadConsoleSignInMethods(), () => undefined)]
      : [];
  const [address] = await Promise.all([
    startConsoleAccount({ boot, home: consoleBase, navigate: (url) => window.location.assign(url), pageOrigin: window.location.origin, pathname: window.location.pathname, search: window.location.search, hash: window.location.hash, showPath: (path) => {
      if (window.location.pathname !== path) window.history.pushState(null, "", path);
    } }),
    ...views,
  ]);
  const projects = useConsoleProjects();
  // The app answers before the page renders, so the first paint changes once: to the app, or to the step it needs. A
  // slow app gets 2.5 seconds. Then the page renders and says that the app is still opening. With the answer that the
  // device kept from the last visit, the app opens at once.
  if (projects.gate.value.kind === "site") void openConsoleSite();
  else if (projects.gate.value.kind === "opening") {
    const opening = openConsoleProject().catch(() => undefined);
    openedAtOnce = projects.gate.value.kind === "ready";
    // While the app answers, the code of its first frame loads: the team menu and the app switcher of the rail, and the
    // Overview on the home path. The timer lets the request to the app go out first.
    setTimeout(() => {
      void import("../components/console-account-menu.vue").catch(() => undefined);
      void import("../components/console-account-link.vue").catch(() => undefined);
      if (window.location.pathname === consoleBase) void ConsoleHome().catch(() => undefined);
    });
    await Promise.race([opening, consoleProjectReady(), new Promise(resolve => setTimeout(resolve, 2_500))]);
  }
  // The next visit to the home path draws the frame that this one shows: an open app, or the team sidebar.
  watch(() => projects.gate.value.kind, (kind) => {
    const view = kind === "ready" ? "app" : ["home", "empty", "setup", "problem"].includes(kind) ? "shell" : undefined;
    if (view) document.cookie = `vitehub-console-view=${view}; Path=/; Max-Age=31536000; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
  }, { immediate: true });
  // The app of a `?app=<id>` link is open now, so the address goes back to the home path before the router reads it.
  // An `/open` link shows the page that it names.
  if (address) window.history.replaceState(null, "", address);
  else if (new URLSearchParams(window.location.search).has("app")) window.history.replaceState(null, "", consoleBase);
  // Back and Forward between the account pages, such as from `/team` to `/start`, load that page. In an open project,
  // the router handles them.
  window.addEventListener("popstate", () => {
    if (useConsoleProjects().gate.value.kind !== "ready") window.location.reload();
  });
}
else {
  startConsoleProjects({
    base: hostBase,
    home: consoleBase,
    mode: "embedded",
    navigate: (url) => window.location.assign(url),
    pageOrigin: window.location.origin,
    storage: memoryProjectStorage(),
  });
}
const sectionsBase = consoleSectionsPath;
const capabilitiesBase = "/_vitehub/api/invocation-capabilities";

const router = createRouter({
  history: createWebHistory(consoleBase),
  routes: [
    consolePendingSectionRoute,
    { component: ConsoleLogs, name: "vitehub-console-logs", path: "/logs", meta: { consoleSection: "logs", title: "Logs · ViteHub Console" }, props: { logsBase: "/_vitehub/api/logs", sectionsBase } },
    { component: ConsoleEnv, name: "vitehub-console-env", path: "/env", meta: { consoleSection: "env", title: "Env · ViteHub Console" }, props: { agentsBase: "/_vitehub/api/agents", definitionsBase: "/_vitehub/api/definitions", kvBase: "/_vitehub/api/kv", envBase: "/_vitehub/api/env", searchBase: "/_vitehub/api/search", sectionsBase } },
    {
      component: ConsoleMcpClient,
      name: "vitehub-console-mcp-client",
      path: "/mcp-client",
      meta: { consoleSection: "mcp-client", title: "MCP client · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
      },
    },
    // Authorization servers send the browser here after an MCP sign-in (`<Console origin>/mcp-client/callback`).
    {
      component: ConsoleMcpCallback,
      name: "vitehub-console-mcp-client-callback",
      path: "/mcp-client/callback",
      meta: { consoleSection: "mcp-client", title: "MCP client · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleHome,
      name: "vitehub-console",
      path: "/",
      props: {
        agentsBase: "/_vitehub/api/agents",
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
      },
      meta: { title: "ViteHub Console" },
    },
    {
      component: ConsoleAppSettings,
      name: "vitehub-console-app-settings",
      path: "/app-settings/:section(primitives|connection|danger)?",
      meta: { title: "Settings · ViteHub Console" },
      props: { sectionsBase },
    },
    {
      component: ConsoleApp,
      name: "vitehub-console-agents",
      path: "/agents",
      meta: { consoleSection: "agents", title: "Agents · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        apiBase: "/_vitehub/api/invocations",
        capabilitiesBase,
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
        usageBase: "/_vitehub/api/usage",
      },
    },
    {
      component: ConsoleApp,
      name: "vitehub-console-agent",
      path: "/agents/:agent",
      meta: { consoleSection: "agents", title: "Agents · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        apiBase: "/_vitehub/api/invocations",
        capabilitiesBase,
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
        usageBase: "/_vitehub/api/usage",
      },
    },
    {
      component: ConsoleApp,
      name: "vitehub-console-invocation",
      path: "/agents/:agent/invocations/:invocation",
      meta: { consoleSection: "agents", title: "Agents · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        apiBase: "/_vitehub/api/invocations",
        capabilitiesBase,
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
        usageBase: "/_vitehub/api/usage",
      },
    },
    {
      component: ConsoleBlob,
      name: "vitehub-console-blob",
      path: "/blob",
      meta: { consoleSection: "blob", title: "Blob · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        blobBase: "/_vitehub/api/blob",
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleSkills,
      name: "vitehub-console-skills",
      path: "/skills",
      meta: { consoleSection: "skills", title: "Skills · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        skillsBase: "/_vitehub/api/skills",
        sectionsBase,
      },
    },
    {
      component: ConsoleChannels,
      name: "vitehub-console-channels",
      path: "/channels",
      meta: { consoleSection: "channels", title: "Channels · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        channelsBase: "/_vitehub/api/channels",
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleSite,
      name: "vitehub-console-site",
      path: "/site",
      meta: { consoleSection: "site", title: "Site access · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleKv,
      name: "vitehub-console-kv",
      path: "/kv",
      meta: { consoleSection: "kv", title: "KV · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleCache,
      name: "vitehub-console-cache",
      path: "/cache",
      meta: { consoleSection: "cache", title: "Cache · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleApp,
      name: "vitehub-console-usage",
      path: "/usage",
      meta: { consoleSection: "usage", title: "Usage · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        apiBase: "/_vitehub/api/invocations",
        capabilitiesBase,
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
        usageBase: "/_vitehub/api/usage",
      },
    },
    {
      component: ConsoleSetup,
      name: "vitehub-console-setup",
      path: "/setup",
      meta: { consoleSection: "setup", title: "Setup · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
      },
    },
    {
      component: ConsoleDatabase,
      name: "vitehub-console-databases-schema",
      path: consoleDatabasesSchemaPath,
      meta: { consoleSection: "databases", title: "Schema · ViteHub Console" },
      props: {
        agentsBase: "/_vitehub/api/agents",
        databaseBase: "/_vitehub/api/database",
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
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
        agentsBase: "/_vitehub/api/agents",
        databaseBase: "/_vitehub/api/database",
        definitionsBase: "/_vitehub/api/definitions",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        view: "data",
        sectionsBase,
      },
    },
  ],
});

const loadSections = createConsoleSectionLoader(sectionsBase);

// The document editor loads Tiptap and the Comark kit, so it is a separate chunk.
const ConsoleDocuments = () => import("../components/console-documents.vue");

const contributedRoutes = new Map();
let contributedNavigationVersion = 0;

/** Replaces contributed routes and their descriptors with this visit's navigation. */
function addContributedRoutes(navigation) {
  const current = router.currentRoute.value;
  const refresh = current.matched.some(route => contributedRoutes.has(route.name));
  for (const remove of contributedRoutes.values()) remove();
  contributedRoutes.clear();
  contributedNavigationVersion++;
  const addRoute = (route) => contributedRoutes.set(route.name, router.addRoute({
    ...route,
    meta: { ...route.meta, contributedNavigationVersion },
  }));
  for (const section of navigation.sections) {
    const details = navigation.contributions[section];
    const name = consoleSectionRouteName(section);
    if (!details || router.hasRoute(name)) continue;
    if (details.view.kind === "auth-management") {
      addRoute({
        component: ConsoleAuth,
        name,
        path: "/auth/:page(overview|users|sessions|organizations|agents|activity)?",
        meta: { consoleSection: section, title: "Auth · ViteHub Console" },
        props: { sectionsBase },
      });
      continue;
    }
    if (details.view.kind === "document-editor") {
      const props = {
        agentsBase: "/_vitehub/api/agents",
        definitionsBase: "/_vitehub/api/definitions",
        details,
        documentsBase: "/_vitehub/api/documents",
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
      };
      // The main view and every page render the same component, so the section sidebar stays mounted between them.
      for (const route of describeConsoleSectionRoutes(details)) {
        if (route.redirect) {
          addRoute({ name: route.name, path: route.path, redirect: route.redirect });
          continue;
        }
        const page = details.pages?.find(entry => entry.id === route.page);
        addRoute({
          component: ConsoleDocuments,
          name: route.name,
          path: route.path,
          meta: { consolePage: route.page, consoleSection: section, title: `${page ? `${page.label} · ` : ""}${details.label} · ViteHub Console` },
          props,
        });
      }
      continue;
    }
    if (details.view.kind === "webhooks") {
      router.addRoute({
        component: ConsoleWebhooks,
        name,
        path: `/${section}`,
        meta: { consoleSection: section, title: `${details.label} · ViteHub Console` },
        props: { definitionsBase: "/_vitehub/api/definitions", details, sectionsBase },
      });
      continue;
    }
    if (details.view.kind === "operation-view") {
      addRoute({
        component: ConsoleOperationView,
        name,
        path: `/${section}`,
        meta: { consoleSection: section, title: `${details.label} · ViteHub Console` },
        props: { definitionsBase: "/_vitehub/api/definitions", details, sectionsBase },
      });
      continue;
    }
    addRoute({
      component: ConsoleDefinitions,
      name,
      path: `/${section}`,
      meta: { consoleSection: section, title: `${details.label} · ViteHub Console` },
      props: {
        agentsBase: "/_vitehub/api/agents",
        definitionsBase: "/_vitehub/api/definitions",
        details,
        ...(section === "rate-limits" ? { rateLimitBase: "/_vitehub/api/rate-limit" } : {}),
        ...(section === "schedules" ? { scheduleRunBase: "/_vitehub/api/schedule-run" } : {}),
        ...(section === "workflows" ? { workflowBase: "/_vitehub/api/workflow" } : {}),
        ...(details.view.kind === "workspace-browser" ? { workspaceFilesBase: "/_vitehub/api/workspace-files" } : {}),
        kvBase: "/_vitehub/api/kv",
        searchBase: "/_vitehub/api/search",
        sectionsBase,
      },
    });
  }
  if (refresh) {
    const next = router.resolve(current.fullPath);
    const pageRemoved = current.meta.consolePage && next.meta.consolePage !== current.meta.consolePage;
    void router.replace(next.matched.length && !pageRemoved
      ? { path: current.path, query: current.query, hash: current.hash, force: true }
      : { name: "vitehub-console", force: true });
  }
}
subscribeConsoleNavigation(sectionsBase, addContributedRoutes);
// An `account` Console opens with the navigation that the device kept. When the answer of this visit no longer has the
// section of the page, the page goes to the Overview.
subscribeConsoleNavigation(sectionsBase, (navigation) => {
  if (isConsoleSectionRevoked(router.currentRoute.value.meta.consoleSection, navigation)) void router.replace({ name: "vitehub-console" });
});

const pageCodeHost = browserConsoleChunkHost(path => void router.push(path), path => router.resolve(path).href);
const recoverPageCode = createConsoleChunkRecovery(pageCodeHost);
router.onError((error, to) => {
  if (isConsoleChunkError(error)) recoverPageCode(to.fullPath);
});
router.afterEach((_to, _from, failure) => {
  if (!failure) forgetConsoleChunkReload(pageCodeHost.storage);
});

router.beforeEach(async (to) => {
  // The first page waits until the project opens, so its requests go to the open project.
  await consoleProjectReady();
  // Contributed section routes exist only after the navigation response arrives.
  return resolveConsoleSectionDeepLink(router, to, async () => {
    const navigation = await loadConsoleNavigation(sectionsBase);
    if (navigation) addContributedRoutes(navigation);
  });
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
const app = createApp(App, { sectionsBase })
  .provide(consoleAppearanceKey, appearance)
  .provide(consoleAccountViewsKey, accountViews)
  .use(router)
  .use(ui, { router: () => router.currentRoute.value })
  .use(createViteHubUI({ icons: vitehubTheme.icons }));
// An app that opened from the device renders its first page in the first frame: the router loads the code of the page,
// usually from the HTTP cache, before the mount. A page whose code takes more than 1 second mounts in the frame, which
// says that the Console is opening.
if (openedAtOnce) await Promise.race([router.isReady().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 1_000))]);
app.mount("#app");
// The page tools, such as Comments on the Console's own pages, start after the mount, so their session check and code
// do not delay the Console. The account page tells the server not to add them (hosted/account.html).
if (account) void loadConsolePageTools(consoleBase, { search: window.location.search, cookie: document.cookie });

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

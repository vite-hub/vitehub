import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { defineConfig } from "vite-plus";
import * as v from "valibot";

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports";
import { end, parseProgram, start } from "@vite-hub/internal/ast";

import frameworkPackageManifest from "./package.json" with { type: "json" };

const manifestStringLeavesSchema: v.GenericSchema<unknown, string[]> = v.lazy(() =>
  v.union([
    v.pipe(
      v.string(),
      v.transform((value) => [value]),
    ),
    v.pipe(
      v.array(manifestStringLeavesSchema),
      v.transform((values) => values.flat()),
    ),
    v.pipe(
      v.record(v.string(), manifestStringLeavesSchema),
      v.transform((value) => Object.values(value).flat()),
    ),
  ]),
);

export function distributionEntriesFromManifest(value: unknown): string[] {
  return [
    ...new Set(
      v
        .parse(manifestStringLeavesSchema, value)
        // A browser script such as `./dist/page/pill.iife.js` has its own build below.
        .filter((target) => target.startsWith("./dist/") && target.endsWith(".js") && !target.endsWith(".iife.js"))
        .map((target) => target.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")),
    ),
  ].sort();
}

export const distributionBinEntries = Object.fromEntries(
  Object.entries(frameworkPackageManifest.bin).map(([name, target]) => {
    const [entry] = distributionEntriesFromManifest(target);
    if (!entry) throw new TypeError(`Unsupported ViteHub binary target: ${target}`);
    return [name, entry];
  }),
);

const distributionEntries = [
  ...distributionEntriesFromManifest([
    frameworkPackageManifest.exports,
    frameworkPackageManifest.bin,
  ]),
  "src/console/runtime/client/sections.ts",
].sort();

const runtimeEntries = [
  ...distributionEntries,
  // Generated code imports these modules by path. They are not package exports.
  "src/_internal/auth/internal/server.ts",
  "src/_internal/auth/runtime/server.ts",
  "src/_internal/runtime/internal/h3.ts",
  "src/_internal/runtime/request-policy.ts",
  "src/internal/agent-invocations-libsql.ts",
  "src/internal/database-runtime-state.ts",
  "src/internal/disabled-upstash-driver.ts",
  "src/internal/disabled-redis-driver.ts",
  "src/task/operations.ts",
  "src/durability/operations.ts",
  "src/comments/realtime.ts",
  "src/comments/runtime/auth.ts",
  "src/connections/agent.ts",
  "src/console/runtime/server/blob.ts",
  "src/console/runtime/server/database.ts",
  "src/console/runtime/server/definitions.ts",
  "src/console/runtime/server/env.ts",
  "src/console/runtime/server/operation-contributions.ts",
  "src/console/runtime/server/sections.ts",
  "src/console/auth-types.ts",
  "src/console/runtime/console-route.ts",
  "src/console/runtime/client/account.ts",
  "src/console/runtime/client/account-views.ts",
  "src/console/runtime/client/appearance.ts",
  "src/console/runtime/client/comment-thread.ts",
  "src/console/runtime/client/invocation.ts",
  "src/console/runtime/client/invocation-deletion.ts",
  "src/console/runtime/client/request.ts",
  "src/console/runtime/client/ticket.ts",
  "src/console/runtime/client/blob-media.ts",
  "src/console/runtime/client/documents.ts",
  "src/console/runtime/client/format.ts",
  "src/console/runtime/client/editor.ts",
  "src/console/runtime/client/env-groups.ts",
  "src/console/runtime/client/env-status.ts",
  "src/console/runtime/client/live.ts",
  "src/console/runtime/client/media.ts",
  "src/console/runtime/client/media-library.ts",
  "src/console/runtime/client/media-uploads.ts",
  "src/console/runtime/client/presence.ts",
  "src/console/runtime/client/preview.ts",
  "src/console/runtime/client/publish.ts",
  "src/console/runtime/client/mcp-client.ts",
  "src/console/runtime/client/operation-view.ts",
  "src/console/runtime/client/problem.ts",
  "src/console/runtime/client/project.ts",
  "src/console/runtime/client/project-link.ts",
  "src/console/runtime/client/project-session.ts",
  "src/console/runtime/client/projects.ts",
  "src/console/runtime/client/rate-limit.ts",
  "src/console/runtime/client/read-only.ts",
  "src/console/runtime/client/route-query.ts",
  "src/console/runtime/client/schedule-run.ts",
  "src/console/runtime/client/schema-form.ts",
  "src/console/runtime/client/site-access.ts",
  "src/console/runtime/client/toast.ts",
  "src/console/runtime/client/workflow.ts",
  "src/console/runtime/auth-operations.ts",
  "src/console/runtime/definitions.ts",
  "src/console/runtime/mcp-client.ts",
  "src/console/runtime/rpc.ts",
  "src/console/runtime/sections.ts",
  "src/console/runtime/site-access.ts",
  "src/console/runtime/skills.ts",
  // Generated Console output imports these when the server starts. Own files keep the request code out of startup.
  "src/console/runtime/server/access-policy.ts",
  "src/console/runtime/server/development.ts",
  "src/console/runtime/server/page-tool.ts",
  "src/console/runtime/server/runtime.ts",
  "src/console/runtime/server/agents.get.ts",
  "src/console/runtime/server/channel-replay.ts",
  "src/console/runtime/server/database.get.ts",
  "src/console/runtime/server/definitions.get.ts",
  "src/console/runtime/server/documents.ts",
  "src/console/runtime/server/invocation-capabilities.get.ts",
  "src/console/runtime/server/rpc.ts",
  "src/console/runtime/server/invocation.get.ts",
  "src/console/runtime/server/invocation-workspace.get.ts",
  "src/console/runtime/server/workspace-files.get.ts",
  "src/console/runtime/server/invocations.get.ts",
  "src/console/runtime/server/env.get.ts",
  "src/console/runtime/server/auth.ts",
  "src/console/runtime/server/tickets.ts",
  "src/console/runtime/server/logs.get.ts",
  "src/console/runtime/server/search.get.ts",
  "src/console/runtime/server/sections.get.ts",
  "src/console/runtime/server/setup.ts",
  "src/console/runtime/server/usage.get.ts",
  "src/console/runtime/server/status.get.ts",
  // The page tools session route, and the Auth reader that the Console page tool loads with the first session request.
  "src/console/runtime/server/page-auth.ts",
  "src/console/runtime/server/page-session.ts",
];

const skillsSource = resolve(import.meta.dirname, "../../docs/skills");
// The Console publishes the skills for apps that use ViteHub. The other skills in docs/skills are for ViteHub contributors.
const consoleSkills = ["vitehub"];
// Optional owner packages. The root declarations inline their option types, so an app without the package still type-checks.
const configurationOwners = /^@vite-hub\/(?:agent|auth|blob|browser|channels|comments|connections|database|email|i18n|kv|mcp|queue|rate-limit|realtime|sandbox|schedule|workflow|workspace)(?:\/|$)/;
const agentDeclarationRoot = `${resolve(import.meta.dirname, "../agent/dist").replaceAll("\\", "/")}/`;

export default defineConfig({
  pack: [
    {
      ...packDefaults,
      // `project.get` reports this version, without the package manifest in the app's server output.
      define: { __VITE_HUB_VERSION__: JSON.stringify(frameworkPackageManifest.version) },
      copy: [
        { from: "src/cloudflare-prerender.mjs", to: "dist" },
        { from: "src/error-diagnostics.ts", to: "dist" },
        {
          from: "src/console/runtime/components/console-lazy-views.ts",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-wrap.ts",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-app.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-new-chat.ts",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-agent-list.ts",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-connection-state.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-connection.ts",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-session-bootstrap.ts",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-blob.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-database-model.ts",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-database.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-definitions.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-comment-thread.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-operation-view.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-workflow-actions.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-frame.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-home.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-invocation-composer.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-account-link.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-account-menu.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-account-setup.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-account-sign-in.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-account-settings.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-account-shell.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-account-home.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-account-snippet.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-account-team.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-account-unlink.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-kv.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-site.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-mark.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-rail.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-project-switcher.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-search.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-search-palette.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-section-icon.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-session-code-preview.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-session-code-language.ts",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-session-actions.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-session-cancel.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-session-inspector.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/invocation",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-workspace-file.ts",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-workspace-history.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-session-loading.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-session-navbar.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-agent-session.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-page-changes.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-session-copy-link.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-workspace-browser.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-session-trace-model.ts",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-session-trace.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-session.css",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-usage.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-usage-chart.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-usage-model-detail.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-usage-model.ts",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-usage-share-bar.vue",
          to: "dist/console/runtime/components",
        },
        { from: "src/console/runtime/components/console-env.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-env-details.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-activity-feed.vue", to: "dist/console/runtime/components" },
        {
          from: "src/console/runtime/components/console-auth.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-auth-detail.vue",
          to: "dist/console/runtime/components",
        },
        {
          from: "src/console/runtime/components/console-auth-action.vue",
          to: "dist/console/runtime/components",
        },
        { from: "src/console/runtime/client/auth-management.ts", to: "dist/console/runtime/client" },
        { from: "src/console/runtime/client/document-cache.ts", to: "dist/console/runtime/client" },
        // The copied invocation helpers import the formatters as TypeScript.
        { from: "src/console/runtime/client/format.ts", to: "dist/console/runtime/client" },
        { from: "src/console/runtime/client/highlight-languages.ts", to: "dist/console/runtime/client" },
        { from: "src/console/runtime/components/console-auth-overview.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-auth-activity.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-auth-chart.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-auth-event-list.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-auth-event-setup.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-auth-user-events.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-state.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-code-text.vue", to: "dist/console/runtime/components" },
        ...["console-mcp-client.vue", "console-mcp-callback.vue", "console-mcp-connect.vue", "console-mcp-connection.vue", "console-mcp-content.vue", "console-mcp-items.vue"].map(file => ({ from: `src/console/runtime/components/${file}`, to: "dist/console/runtime/components" })),
        { from: "src/console/runtime/components/console-skills.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-skill-tree.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-skill-file.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-loading.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-documents.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-document-dashboard.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-media-library.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-media-browser.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-media-crops.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-media-detail.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-media-field.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-media-focal.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-media-move.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-media-picker.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-media-uploads.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-document-settings.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-seo-panel.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-setup-hint.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-document-list.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-document-editor.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-document-preview.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-document-diff.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-document-history.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-schema-form.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-markdown-editor.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-comark-component.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-media-dialog.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-property-row.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-page-header.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-presence-avatars.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-page-toolbar.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-schema-field.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-schema-list.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-schema-date-input.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-relative-time.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-value.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-property-list.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-facts.ts", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-section.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-stat-grid.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-confirm.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-rate-limit.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-blob-detail.vue", to: "dist/console/runtime/components" },
        { from: "src/console/runtime/components/console-toaster.vue", to: "dist/console/runtime/components" },
        { from: "src/ui/styles.css", to: "dist/ui" },
        { from: "templates/cloudflare-types.d.ts", to: "dist" },
      ],
      deps: {
        // Agent-only apps need the client-free journal constructor without installing the optional Database package.
        neverBundle: ["esbuild", "vite", /^@vite-hub\/(?!internal(?:\/|$)|database\/runtime\/libsql-drizzle$)/],
        alwaysBundle: [/^@vite-hub\/internal/, "@vite-hub/database/runtime/libsql-drizzle"],
        onlyBundle: false,
      },
      // Root declarations are emitted separately so feature exports cannot pull optional types into them.
      dts: { entry: runtimeEntries.filter(entry => !["src/index.ts", "src/nuxt.ts"].includes(entry)) },
      plugins: [
        {
          // Emit the skills and the well-known index that `npx skills add <app>/_vitehub` reads. The pack task owns dist,
          // so the task cache can replay it. A write to a folder outside dist made the build uncacheable.
          name: "vite-hub-console-skills",
          generateBundle() {
            const skills = consoleSkills.map((name) => {
              const root = resolve(skillsSource, name);
              const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(resolve(root, "SKILL.md"), "utf8"))?.[1] ?? "";
              const field = (key: string) => new RegExp(`^${key}: (.+)$`, "m").exec(frontmatter)?.[1];
              const description = field("description");
              if (field("name") !== name || !description) throw new TypeError(`docs/skills/${name}/SKILL.md needs the name "${name}" and a description.`);
              const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => relative(root, resolve(entry.parentPath, entry.name))).sort();
              for (const file of files) {
                this.emitFile({ type: "asset", fileName: `console/runtime/public/skills/${name}/${file}`, source: readFileSync(resolve(root, file)) });
              }
              return { name, description, files };
            });
            this.emitFile({ type: "asset", fileName: "console/runtime/public/skills/index.json", source: `${JSON.stringify({ skills }, null, 2)}\n` });
          },
        },
        {
          name: "vite-hub-env-config-declarations",
          generateBundle(_options, bundle) {
            for (const file of ["index.d.ts", "env.d.ts"]) {
              const chunk = bundle[file];
              if (chunk?.type === "chunk") chunk.code = `import "@vite-hub/env/vite";\n${chunk.code}`;
            }
          },
        },
      ],
      entry: runtimeEntries,
      exports: {
        exclude: ["bin"],
        bin: distributionBinEntries,
        customExports(exports) {
          delete exports["./console/auth-types"];
          delete exports["./console/runtime/console-route"];
          delete exports["./console/runtime/client/sections"];
          delete exports["./console/runtime/client/account"];
          delete exports["./console/runtime/client/account-views"];
          delete exports["./console/runtime/client/appearance"];
          delete exports["./console/runtime/client/comment-thread"];
          delete exports["./console/runtime/client/invocation"];
          delete exports["./console/runtime/client/invocation-deletion"];
          delete exports["./console/runtime/client/request"];
          delete exports["./console/runtime/client/ticket"];
          delete exports["./console/runtime/client/blob-media"];
          delete exports["./console/runtime/client/documents"];
          delete exports["./console/runtime/client/editor"];
          delete exports["./console/runtime/client/env-groups"];
          delete exports["./console/runtime/client/env-status"];
          delete exports["./console/runtime/client/format"];
          delete exports["./console/runtime/client/live"];
          delete exports["./console/runtime/client/mcp-client"];
          delete exports["./console/runtime/client/operation-view"];
          delete exports["./console/runtime/client/media"];
          delete exports["./console/runtime/client/media-library"];
          delete exports["./console/runtime/client/media-uploads"];
          delete exports["./console/runtime/client/presence"];
          delete exports["./console/runtime/client/preview"];
          delete exports["./console/runtime/client/publish"];
          delete exports["./console/runtime/client/problem"];
          delete exports["./console/runtime/client/project"];
          delete exports["./console/runtime/client/project-link"];
          delete exports["./console/runtime/client/project-session"];
          delete exports["./console/runtime/client/projects"];
          delete exports["./console/runtime/client/rate-limit"];
          delete exports["./console/runtime/client/read-only"];
          delete exports["./console/runtime/client/route-query"];
          delete exports["./console/runtime/client/schedule-run"];
          delete exports["./console/runtime/client/schema-form"];
          delete exports["./console/runtime/client/site-access"];
          delete exports["./console/runtime/client/toast"];
          delete exports["./console/runtime/client/workflow"];
          delete exports["./console/runtime/auth-operations"];
          delete exports["./console/runtime/definitions"];
          delete exports["./console/runtime/mcp-client"];
          delete exports["./console/runtime/rpc"];
          delete exports["./console/runtime/sections"];
          delete exports["./console/runtime/site-access"];
          delete exports["./console/runtime/skills"];
          delete exports["./console/runtime/server/agents.get"];
          delete exports["./console/runtime/server/blob"];
          delete exports["./console/runtime/server/channel-replay"];
          delete exports["./console/runtime/server/database"];
          delete exports["./console/runtime/server/database.get"];
          delete exports["./console/runtime/server/definitions"];
          delete exports["./console/runtime/server/definitions.get"];
          delete exports["./console/runtime/server/documents"];
          delete exports["./console/runtime/server/invocation-capabilities.get"];
          delete exports["./console/runtime/server/rpc"];
          delete exports["./console/runtime/server/invocation.get"];
          delete exports["./console/runtime/server/invocation-workspace.get"];
          delete exports["./console/runtime/server/workspace-files.get"];
          delete exports["./console/runtime/server/invocations.get"];
          delete exports["./console/runtime/server/env.get"];
          delete exports["./console/runtime/server/auth"];
          delete exports["./console/runtime/server/tickets"];
          delete exports["./console/runtime/server/env"];
          delete exports["./console/runtime/server/logs.get"];
          delete exports["./console/runtime/server/mcp-client-operations"];
          delete exports["./console/runtime/server/access-policy"];
          delete exports["./console/runtime/server/development"];
          delete exports["./console/runtime/server/operation-contributions"];
          delete exports["./console/runtime/server/page-auth"];
          delete exports["./console/runtime/server/page-session"];
          delete exports["./console/runtime/server/page-tool"];
          delete exports["./console/runtime/server/runtime"];
          delete exports["./console/runtime/server/search.get"];
          delete exports["./console/runtime/server/sections.get"];
          delete exports["./console/runtime/server/sections"];
          delete exports["./console/runtime/server/setup"];
          delete exports["./console/runtime/server/usage.get"];
          delete exports["./console/runtime/server/status.get"];
          // Generated code imports `src/internal/*` entries by path. They are not public API.
          for (const key of Object.keys(exports)) if (/^\.\/_?internal\//.test(key)) delete exports[key];
          delete exports["./task/operations"];
          delete exports["./durability/operations"];
          delete exports["./comments/realtime"];
          delete exports["./comments/runtime/auth"];
          delete exports["./connections/agent"];
          return normalizePackageExports({
            ...frameworkPackageManifest.exports,
            ...exports,
            "./console/mcp-client": "./dist/console/runtime/server/mcp-client-operations.js",
            // A browser script, not a module: no types and no `import` condition.
            "./page/pill.js": { default: "./dist/page/pill.iife.js" },
            "./ui/styles.css": "./dist/ui/styles.css",
            "./tsconfig": "./tsconfig.json",
          });
        },
        inlinedDependencies: false,
      },
    },
    {
      clean: false,
      entry: { index: "src/index.ts", nuxt: "src/nuxt.ts" },
      tsconfig: "tsconfig.build.json",
      treeshake: { moduleSideEffects: false },
      dts: { tsconfig: "tsconfig.declarations.json", emitDtsOnly: true },
      plugins: [{
        name: "vite-hub-agent-configuration-declarations",
        transform: {
          order: "pre",
          handler(code, id) {
            if (!id.replaceAll("\\", "/").startsWith(agentDeclarationRoot) || !id.endsWith(".d.ts")) return;
            // Agent runtime augmentations retain optional model and Workspace tool types.
            // The framework root only inlines configuration types from this owner.
            const augmentations = parseProgram(code).program.body.filter(node => node.type === "TSModuleDeclaration" && node.kind !== "namespace");
            if (!augmentations.length) return;
            let result = code;
            for (const node of augmentations.reverse()) result = result.slice(0, start(node)) + result.slice(end(node));
            return result;
          },
        },
      }, {
        name: "vite-hub-env-config-declarations",
        generateBundle(_options, bundle) {
          const chunk = bundle["index.d.ts"];
          if (chunk?.type === "chunk") chunk.code = `import "@vite-hub/env/vite";\n${chunk.code}`;
        },
      }],
      deps: {
        neverBundle: ["esbuild", "vite", /^@vite-hub\/(?!internal(?:\/|$)|database\/runtime\/libsql-drizzle$)/],
        alwaysBundle: [/^@vite-hub\/internal/, "@vite-hub/database/runtime/libsql-drizzle"],
        onlyBundle: false,
        dts: {
          neverBundle: ["esbuild", "vite"],
          alwaysBundle: [/^@vite-hub\/internal/, configurationOwners],
        },
      },
      outExtensions: () => ({ dts: ".d.ts", js: ".js" }),
    },
    {
      // The page tools loader at `/_vitehub/page/assets/loader.js`, for an app with the Console and no Comments. It has its
      // own build, so it shares no chunk with the server code.
      deps: { alwaysBundle: [/./], onlyBundle: false },
      dts: false,
      entry: { "console/runtime/page/loader": "src/page/loader.ts" },
      minify: true,
      outExtensions: () => ({ js: ".js" }),
      platform: "browser",
      tsconfig: "tsconfig.build.json",
    },
    {
      // The Console segment of the page tools pill, at `/_vitehub/console/assets/page-tool.js` (see src/page/console.ts).
      deps: { alwaysBundle: [/./], onlyBundle: false },
      dts: false,
      entry: { "console/runtime/page-tool/page-tool": "src/page/console.ts" },
      minify: true,
      outExtensions: () => ({ js: ".js" }),
      platform: "browser",
      tsconfig: "tsconfig.build.json",
    },
    {
      // The page pill for other tools' bars, as one script that declares `ViteHubPagePill` (see src/page/pill.ts).
      deps: { alwaysBundle: [/./], onlyBundle: false },
      dts: false,
      entry: { "page/pill": "src/page/pill.ts" },
      format: "iife",
      globalName: "ViteHubPagePill",
      minify: true,
      outExtensions: () => ({ js: ".js" }),
      platform: "browser",
      tsconfig: "tsconfig.build.json",
    },
  ],
});

import ui from "@vite-hub/ui/vite";
import vue from "@vitejs/plugin-vue";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { defineConfig } from "vite";

import { consoleAppConfig } from "./src/console/app.config";
import { consoleContributedSectionIcons } from "./src/console/contributions";

const clientRoot = resolve(import.meta.dirname, "src/console/runtime/client");
const skillsSource = resolve(import.meta.dirname, "../../docs/skills");
const skillsOutDir = resolve(import.meta.dirname, ".vitehub/skills");
// The Console publishes the skills for apps that use ViteHub. The other skills in docs/skills are for ViteHub contributors.
const consoleSkills = ["vitehub"];

/** Copy the skills and write the well-known index that `npx skills add <app>/_vitehub` reads. */
function writeConsoleSkills(): void {
  rmSync(skillsOutDir, { force: true, recursive: true });
  mkdirSync(skillsOutDir, { recursive: true });
  const skills = consoleSkills.map((name) => {
    const root = resolve(skillsSource, name);
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(resolve(root, "SKILL.md"), "utf8"))?.[1] ?? "";
    const field = (key: string) => new RegExp(`^${key}: (.+)$`, "m").exec(frontmatter)?.[1];
    const description = field("description");
    if (field("name") !== name || !description) throw new TypeError(`docs/skills/${name}/SKILL.md needs the name "${name}" and a description.`);
    cpSync(root, resolve(skillsOutDir, name), { recursive: true });
    return { name, description, files: readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => relative(root, resolve(entry.parentPath, entry.name))).sort() };
  });
  writeFileSync(resolve(skillsOutDir, "index.json"), `${JSON.stringify({ skills }, null, 2)}\n`);
}

const katexStyleImport = /^@import\s+["']katex\/dist\/katex\.min\.css["'];?\s*$/m;

export default defineConfig({
  // Resolve lazy chunks from the served bundle URL, including application mounts.
  base: "./",
  resolve: {
    alias: {
      "vite-hub/agent/vue": resolve(import.meta.dirname, "../agent/src/vue.ts"),
      "vite-hub/source/client": resolve(import.meta.dirname, "../source/src/client.ts"),
      "vue-router": resolve(import.meta.dirname, "node_modules/vue-router"),
    },
    dedupe: ["vue", "vue-router"],
  },
  plugins: [
    {
      // KaTeX is loaded after the first render. Keep its embedded fonts out of the blocking stylesheet.
      name: "vitehub-console-deferred-katex-styles",
      enforce: "pre",
      transform(code, id) {
        if (/[\\/]ui[\\/]dist[\\/]styles\.css$/.test(id)) return code.replace(katexStyleImport, "");
        // Browsers that run the Console support WOFF2, so omit the larger WOFF and TrueType copies.
        if (/[\\/]katex[\\/]dist[\\/]katex\.min\.css$/.test(id)) {
          return code.replace(/,url\(fonts\/[\w-]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");
        }
      },
    },
    { name: "vitehub-console-skills", closeBundle: writeConsoleSkills },
    vue(),
    ...ui({
      comark: false,
      nuxtUI: {
        // runtime/client/appearance.ts owns the color scheme. Nuxt UI color mode would also write
        // the root class and read the origin-wide `vueuse-color-scheme` key of the host app.
        colorMode: false,
        dts: false,
        icon: {
          clientBundle: {
            // Contributed sections declare their icons in owner packages, which the scan does not read.
            icons: [...consoleContributedSectionIcons],
            scan: {
              globInclude: ["src/console/**/*.{js,ts,vue}"],
            },
          },
        },
        ui: consoleAppConfig,
      },
    }),
  ],
  build: {
    // Keep font assets portable in pnpm patches and self-contained Console bundles.
    assetsInlineLimit: filePath => /\.(?:woff2?|ttf|otf)$/.test(filePath) ? true : undefined,
    emptyOutDir: true,
    outDir: resolve(import.meta.dirname, ".vitehub/console"),
    rolldownOptions: {
      // The `console` page tool is built after this, by page-tool.vite.config.ts, so it shares no chunks with the app.
      input: { main: resolve(clientRoot, "main.js") },
      output: {
        // The Console page links only the entry stylesheet. Deferred chunks load their own styles.
        assetFileNames: asset => asset.names.includes("main.css")
          ? "console-[hash][extname]"
          : "assets/[name]-[hash][extname]",
        chunkFileNames: "chunks/[name]-[hash].js",
        // VueUse holds the color mode writer that Nuxt UI's search keeps behind `colorMode: false`.
        // A separate chunk keeps it out of the entry, so the entry only carries the Console appearance module.
        codeSplitting: { groups: [{ name: "vueuse", test: /[\\/]@vueuse[\\/]core[\\/]/ }] },
        entryFileNames: "console-[hash].js",
      },
    },
  },
});

import type { PrimitiveLanding, PrimitiveProjectFile } from "./types";

const definition = `import { defineDatabase } from "@vite-hub/database"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export default defineDatabase({
  schema: {
    notes: sqliteTable("notes", {
      id: integer("id").primaryKey(),
      title: text("title").notNull(),
    }),
  },
})`;

const query: PrimitiveProjectFile = {
  path: "server/utils/notes.ts",
  language: "typescript",
  content: `import { useDatabase } from "@vite-hub/database/drizzle"

export async function readNotes() {
  const { db, schema } = useDatabase("default")
  return db.select().from(schema.notes)
}`,
};

const viteConfig: PrimitiveProjectFile = {
  path: "vite.config.ts",
  language: "typescript",
  content: `import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({ preset: "node", database: true }),
    // Nitro's prerelease plugin is runtime-compatible with this Vite version.
    nitro() as never,
  ],
})`,
};

function setup(nuxt: boolean): PrimitiveProjectFile {
  return {
    path: "README.md",
    language: "markdown",
    content: `# Database setup

${nuxt ? "Start from a Nuxt 4.5.2 or newer application." : "Use Vite 8 with Nitro 3's Vite integration for server execution."}
Requires Node.js 24.15 or newer.

\`\`\`sh
pnpm add vite-hub @vite-hub/database drizzle-orm
pnpm add -D @vite-hub/cli drizzle-kit${nuxt ? "" : " vite@^8 nitro@3.0.260903-beta"}
pnpm vitehub db generate
pnpm vitehub db migrate
pnpm ${nuxt ? "nuxt" : "vite"} dev
\`\`\`

Call readNotes() from server code running through the configured host.
The default database uses local SQLite. The generated Drizzle import is
server-only and must not be run with plain Node or imported by client code.
`,
  };
}

export const DatabasesLanding = {
  slug: "database",
  name: "Database",
  docsTo: "/docs/database",
  eyebrow: "ViteHub Databases",
  description: "Use one database API with Drizzle schemas that can move from Vite to Nitro and Nuxt.",
  tagline: "A database layer that keeps your schema and your host in sync.",
  accent: "primary",
  supported: ["Drizzle", "Vite", "Nitro", "Nuxt"],
  variants: [
    {
      framework: "vite",
      label: "Vite",
      files: [
        viteConfig,
        { path: "src/database.ts", language: "typescript", content: definition },
        query,
        setup(false),
      ],
    },
    {
      framework: "nitro",
      label: "Nitro",
      files: [
        viteConfig,
        { path: "server/databases/config.ts", language: "typescript", content: definition },
        query,
        setup(false),
      ],
    },
    {
      framework: "nuxt",
      label: "Nuxt",
      files: [
        {
          path: "nuxt.config.ts",
          language: "typescript",
          content: `import { defineNuxtConfig } from "nuxt/config"
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [[viteHubNuxt, { preset: "node", database: true }]],
})`,
        },
        { path: "server/databases/config.ts", language: "typescript", content: definition },
        query,
        setup(true),
      ],
    },
  ],
} satisfies PrimitiveLanding;

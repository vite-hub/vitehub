import type { PrimitiveLanding, PrimitiveProjectFile } from "./types";

const handler = `import { defineQueue } from "vite-hub/queue"

export default defineQueue<{ email: string }>(async ({ payload }) => {
  console.log("Welcome email requested for", payload.email)
})`;

const setup: PrimitiveProjectFile = {
  path: "README.md",
  language: "markdown",
  content: `# Queue on Cloudflare

Use Node.js 24.15 or newer. Run pnpm install, then pnpm build.
The build discovers the welcome-email Queue and emits provider configuration.
The handler logs each delivery; replace it with your idempotent background work.

Queue has no in-memory delivery provider. To send and consume jobs, provision
Cloudflare Queues and deploy the generated Worker with its bindings.
Follow https://vitehub.dev/docs/frameworks-hosts/cloudflare for credentials,
provisioning, and deployment. A build alone does not deliver jobs.

Use runQueue("welcome-email", { email: "ada@example.com" }) from vite-hub/queue
inside a deployed server request to enqueue a job. Successful enqueue means
provider acceptance, not completion. Providers can retry a delivery.`,
};

function packageFile(framework: "vite" | "nitro" | "nuxt"): PrimitiveProjectFile {
  return {
    path: "package.json",
    language: "json",
    content: JSON.stringify({
      name: "queue-starter",
      private: true,
      type: "module",
      scripts: { build: framework === "nuxt" ? "nuxt build" : "vite build" },
      dependencies: { "vite-hub": "latest" },
      devDependencies: framework === "nuxt"
        ? { nuxt: "^4.5.2", typescript: "^6.0.3" }
        : { vite: "^8.2.2", "@types/node": "^24.0.0", typescript: "^6.0.3", ...(framework === "nitro" ? { nitro: "3.0.260903-beta" } : {}) },
    }, null, 2),
  };
}

export const QueueLanding = {
  slug: "queue",
  name: "Queue",
  docsTo: "/docs/queue",
  eyebrow: "ViteHub Queue",
  description: "Move slow work out of the request and keep delivery, retries, and ownership explicit.",
  tagline: "Background work with a place to go.",
  accent: "warning",
  supported: ["Vite", "Nitro", "Nuxt"],
  variants: [
    {
      framework: "vite",
      label: "Vite",
      files: [
        packageFile("vite"),
        {
          path: "vite.config.ts",
          language: "typescript",
          content: `import { resolve } from "node:path"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vitehub({ preset: "cloudflare", queue: true, console: false })],
  build: {
    ssr: true,
    rolldownOptions: { input: resolve(import.meta.dirname, "src/server.ts") },
  },
})`,
        },
        { path: "src/welcome-email.queue.ts", language: "typescript", content: handler },
        {
          path: "src/server.ts",
          language: "typescript",
          content: `export default function handleRequest() {
  return new Response("Queue worker ready")
}`,
        },
        setup,
      ],
    },
    {
      framework: "nitro",
      label: "Nitro",
      files: [
        packageFile("nitro"),
        {
          path: "vite.config.ts",
          language: "typescript",
          content: `import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({ preset: "cloudflare", queue: true, console: false }),
    // Nitro is runtime-compatible; its prerelease Vite types differ.
    nitro() as never,
  ],
})`,
        },
        { path: "server/queues/welcome-email.ts", language: "typescript", content: handler },
        {
          path: "server/routes/index.ts",
          language: "typescript",
          content: `export default () => new Response("Queue worker ready")`,
        },
        setup,
      ],
    },
    {
      framework: "nuxt",
      label: "Nuxt",
      files: [
        packageFile("nuxt"),
        {
          path: "nuxt.config.ts",
          language: "typescript",
          content: `import { defineNuxtConfig } from "nuxt/config"
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [
    [viteHubNuxt, { preset: "cloudflare", queue: true, console: false }],
  ],
})`,
        },
        { path: "server/queues/welcome-email.ts", language: "typescript", content: handler },
        {
          path: "app/app.vue",
          language: "vue",
          content: `<template>
  <p>Queue worker ready</p>
</template>`,
        },
        setup,
      ],
    },
  ],
} satisfies PrimitiveLanding;

import { stubLanding } from "./stub";
import type { PrimitiveLanding, PrimitiveProjectFile } from "./types";

const sandbox = stubLanding("sandbox", "Sandbox", "/docs/sandbox");

const sandboxFiles = [
  {
    path: "server/sandboxes/release-notes/package.json",
    language: "json",
    content: '{\n  "private": true,\n  "type": "module",\n  "vitehub": {\n    "sandbox": {\n      "timeout": 30000\n    }\n  }\n}',
  },
  {
    path: "server/sandboxes/release-notes/index.ts",
    language: "typescript",
    content: 'interface SandboxPayload {\n  notes?: string\n}\n\nexport default async function releaseNotes(payload: SandboxPayload = {}) {\n  return { text: payload.notes?.toUpperCase() || "No notes" }\n}',
  },
  {
    path: "server/release-notes.ts",
    language: "typescript",
    content: 'import { runSandbox } from "@vite-hub/sandbox"\n\nexport function releaseNotes() {\n  return runSandbox("release-notes", { notes: "ship it" })\n}',
  },
];

export const SandboxLanding = {
  ...sandbox,
  eyebrow: "ViteHub Sandbox",
  description: "Run untrusted or isolated work with a clear boundary and a project you can inspect.",
  tagline: "A safe place to run the work your server should not own.",
  accent: "warning",
  supported: ["Vite", "Nitro", "Nuxt"],
  variants: sandbox.variants.map(variant => {
    const dependencies = {
      vite: { "@vite-hub/sandbox": "latest", "@vercel/sandbox": "latest", "vite-hub": "latest", vite: "latest", nitro: "latest" },
      nitro: { "@vite-hub/sandbox": "latest", "@vercel/sandbox": "latest", "vite-hub": "latest", vite: "latest", nitro: "latest" },
      nuxt: { "@vite-hub/sandbox": "latest", "@vercel/sandbox": "latest", nuxt: "latest", "vite-hub": "latest" },
    }[variant.framework];
    const packageFile: PrimitiveProjectFile = {
      path: "package.json",
      language: "json",
      content: JSON.stringify({ private: true, type: "module", dependencies }, null, 2),
    };

    return {
      ...variant,
      illustrative: false,
      files: [
        packageFile,
        variant.framework === "nuxt"
          ? {
              path: "nuxt.config.ts",
              language: "typescript",
              content: 'import viteHubNuxt from "vite-hub/nuxt"\n\nexport default defineNuxtConfig({\n  modules: [[viteHubNuxt, { preset: "vercel", sandbox: true }]],\n})',
            }
          : {
              path: "vite.config.ts",
              language: "typescript",
              content: 'import { nitro } from "nitro/vite"\nimport { vitehub } from "vite-hub"\n\nexport default {\n  plugins: [vitehub({ preset: "vercel", sandbox: true }), nitro()],\n}',
            },
        ...sandboxFiles,
      ],
    };
  }),
} satisfies PrimitiveLanding;

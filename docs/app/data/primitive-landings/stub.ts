import type { PrimitiveLanding } from "./types";

export function stubLanding(slug: string, name: string, docsTo: string): PrimitiveLanding {
  return {
    slug,
    name,
    eyebrow: "ViteHub primitive",
    description: `${name} for every Vite host. Explore the illustrative project layout, then follow the guide to configure your host.`,
    tagline: `Build with ${name}. Keep the shape of your server code.`,
    accent: "primary",
    supported: ["Vite", "Nitro", "Nuxt"],
    docsTo,
    variants: [
      {
        framework: "vite",
        label: "Vite",
        illustrative: true,
        files: [
          { path: "package.json", language: "json", content: '{\n  "private": true,\n  "type": "module"\n}' },
          { path: "vite.config.ts", language: "typescript", content: '// Illustrative pseudocode.\n// Configure Vite and the ViteHub plugin using the host setup guide.' },
          { path: `${slug}.ts`, language: "typescript", content: `// Illustrative pseudocode.\n// Configure ${name} using its documented API.\n// Call the configured primitive from your server code.` },
        ],
      },
      {
        framework: "nitro",
        label: "Nitro",
        illustrative: true,
        files: [
          { path: "package.json", language: "json", content: '{\n  "private": true,\n  "type": "module"\n}' },
          { path: "nitro.config.ts", language: "typescript", content: '// Illustrative pseudocode.\n// Consult the host setup guide for supported Nitro integration.' },
          { path: `server/${slug}/index.ts`, language: "typescript", content: `// Illustrative pseudocode.\n// Configure ${name} using its documented API.\n// Call the configured primitive from your server code.` },
        ],
      },
      {
        framework: "nuxt",
        label: "Nuxt",
        illustrative: true,
        files: [
          { path: "package.json", language: "json", content: '{\n  "private": true,\n  "type": "module"\n}' },
          { path: "nuxt.config.ts", language: "typescript", content: '// Illustrative pseudocode.\n// Configure the ViteHub Nuxt module and deployment preset using the host setup guide.' },
          { path: `server/${slug}/index.ts`, language: "typescript", content: `// Illustrative pseudocode.\n// Configure ${name} using its documented API.\n// Call the configured primitive from your server code.` },
        ],
      },
    ],
  };
}

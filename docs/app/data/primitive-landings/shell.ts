import type { PrimitiveLanding, PrimitiveProjectFile } from "./types";

const files: PrimitiveProjectFile[] = [
  {
    path: "shell.ts",
    language: "typescript",
    content: `import { createShellRuntime } from "vite-hub/shell";
import { createJustBashProvider } from "vite-hub/shell/providers/just-bash";
import { InMemoryFs } from "just-bash";

const fs = Object.assign(new InMemoryFs({
  "/workspace/hello.txt": "Hello from Shell!\\n",
}), { writeFs: true });

const shell = createShellRuntime({
  policy: { maxOutputLength: 10_000, timeout: 30_000 },
  provider: createJustBashProvider({
    commands: ["pwd", "ls", "cat"],
    cwd: "/workspace",
    fs,
  }),
});

const observation = await shell.exec("cat hello.txt");
console.log(observation.stdout);
`,
  },
  {
    path: "package.json",
    language: "json",
    content: JSON.stringify({
      private: true,
      type: "module",
      scripts: { start: "node shell.ts" },
      engines: { node: ">=24.0.0" },
      dependencies: { "vite-hub": "^0.0.4", "just-bash": "^3.6.0" },
    }, null, 2),
  },
  {
    path: "README.md",
    language: "markdown",
    content: `# Shell runtime example

Run \`pnpm install\`, then \`pnpm start\` with Node.js 24 or later.

This server-side example uses the Shell runtime and an explicit Just Bash provider.
The same API can be called from server code in a Vite, Nitro, or Nuxt application.
Shell has no framework plugin, module, or file discovery integration.

The provider uses a writable in-memory filesystem, permits pwd, ls, and cat,
and has no network access. It is not an operating-system isolation boundary.
`,
  },
];

export const ShellLanding = {
  slug: "shell",
  name: "Shell",
  docsTo: "/docs/shell",
  eyebrow: "ViteHub Shell",
  description: "Run commands with explicit ownership, environment, and output instead of hiding a process behind a helper.",
  tagline: "Command execution with a boundary you can reason about.",
  accent: "warning",
  supported: ["Vite server code", "Nitro server code", "Nuxt server code"],
  variants: [
    { framework: "vite", label: "Vite server", files },
    { framework: "nitro", label: "Nitro server", files },
    { framework: "nuxt", label: "Nuxt server", files },
  ],
} satisfies PrimitiveLanding;

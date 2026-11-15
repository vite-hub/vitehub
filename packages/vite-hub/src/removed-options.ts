import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

/**
 * Top-level `vitehub()` options that ViteHub removed or renamed: why each one is gone and how to fix it. The build
 * fails on them, and the `vitehub/valid-vitehub-options` Doctor rule reports them in the editor, from this one table.
 */
export const removedViteHubOptions: Readonly<Record<string, { why: string, fix: string }>> = {
  preset: {
    why: "`preset` was renamed to `host`. Without `host`, ViteHub detects the host, and builds for Node when it finds none.",
    fix: "Rename `preset` to `host`.",
  },
  sandbox: {
    why: "`sandbox` was renamed to `sandboxTask`.",
    fix: "Rename `sandbox` to `sandboxTask: true`.",
  },
  devtools: {
    why: "The `devtools` option was removed with the browser DevTools.",
    fix: "Remove `devtools`. Use the ViteHub Console with `console: true`.",
  },
  logs: {
    why: "`logs` moved into `observability`.",
    fix: "Move it to `observability: { logs: ... }`. Its `evlog` options go to `observability.evlog`. `npx @vite-hub/codemods vitehub-options` moves it.",
  },
  contentImportBase: {
    why: "`contentImportBase` was removed. ViteHub always imports Content from `vite-hub/content`.",
    fix: "Remove `contentImportBase`.",
  },
}

/** Fails with `VITE_HUB_B0024` when `options` set a removed or renamed option, which ViteHub would otherwise ignore. */
export function assertNoRemovedViteHubOptions(options: object, where: string): void {
  for (const [key, { why, fix }] of Object.entries(removedViteHubOptions)) {
    if (Reflect.get(options, key) === undefined) continue
    throw viteHubErrorDiagnostics.VITE_HUB_B0024({ message: `[vitehub] \`${key}\` in ${where} is no longer a ViteHub option. ${why} ${fix}` })
  }
}

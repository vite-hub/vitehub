import type { BundledLanguage, SpecialLanguage } from "shiki"

/** Resolve a workspace path to a Shiki language without reading inherited map properties. */
export function languageForPath(path: string): BundledLanguage | SpecialLanguage {
  const name = path.split("/").at(-1)?.toLowerCase() || ""
  if (name === "dockerfile") return "dockerfile"
  if (name === "makefile") return "make"
  if (name === ".gitignore" || name === ".npmrc") return "shellscript"
  const extension = name.split(".").at(-1) || ""
  const languages: Partial<Record<string, BundledLanguage>> = {
    cjs: "javascript",
    css: "css",
    html: "html",
    js: "javascript",
    json: "json",
    jsonc: "jsonc",
    jsx: "jsx",
    md: "markdown",
    mdx: "mdx",
    mjs: "javascript",
    mts: "typescript",
    scss: "scss",
    sh: "shellscript",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    vue: "vue",
    yaml: "yaml",
    yml: "yaml",
  }
  return Object.hasOwn(languages, extension) ? languages[extension]! : "text"
}

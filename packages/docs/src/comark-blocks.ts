import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

/**
 * The source of a module whose default export is comark-ui's block components by tag, each one loaded on first use.
 * `comark-ui/vue` imports every block package, so a page that rendered with it downloaded all of them. Each tag imports
 * the package that defines its component. The tags that comark-ui defines itself, such as the Mermaid wrapper, import
 * `comark-ui/vue`.
 */
export async function comarkBlocksSource(): Promise<string> {
  let ui: string
  try {
    ui = createRequire(import.meta.url).resolve("comark-ui/package.json")
  }
  catch {
    // An app that installs the module without its dependencies gets no blocks.
    return "export default {}\n"
  }
  const fromUi = createRequire(ui)
  const uiVue = fromUi.resolve("comark-ui/vue")
  const { components } = await import(pathToFileURL(uiVue).href) as { components: Record<string, unknown> }
  const files = new Map<unknown, string>()
  const dependencies = Object.keys((JSON.parse(readFileSync(ui, "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {})
  for (const name of dependencies.filter(name => name.startsWith("comark-"))) {
    let file: string
    try {
      file = fromUi.resolve(`${name}/vue`)
    }
    catch {
      continue // A plugin without components has no `vue` entry.
    }
    const plugin = await import(pathToFileURL(file).href) as { components?: Record<string, unknown> }
    for (const component of Object.values(plugin.components ?? {})) files.set(component, file)
  }
  const entries = Object.entries(components).map(([tag, component]) => {
    const file = JSON.stringify(files.get(component) ?? uiVue)
    return `  ${JSON.stringify(tag)}: defineAsyncComponent(() => import(${file}).then(({ components }) => components[${JSON.stringify(tag)}])),`
  })
  return `import { defineAsyncComponent } from "vue"\nexport default {\n${entries.join("\n")}\n}\n`
}

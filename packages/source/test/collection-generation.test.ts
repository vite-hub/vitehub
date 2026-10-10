import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { prepareSourceGeneration } from "../src/vite.ts"

it.each([
  "function make(route?: false) { return defineCollection(load, { route }) }; export const articles = make()",
  "const options = {}; function unused() { options.route = false }; export const articles = defineCollection(load, options)",
  "let route = undefined; function unused() { route = false }; export const articles = defineCollection(load, { route })",
  "const options = {}; if (false) options.route = false; export const articles = defineCollection(load, options)",
  "const options = { route: false }; if (true) options.route = undefined; export const articles = defineCollection(load, options)",
  "function make(options = { route: false }) { return defineCollection(load, options) }; export const articles = make({})",
  "const options = {}; function publicA() { options.route = undefined }; function publicB() { options.route = undefined }; function make() { dynamic ? publicA() : publicB(); return defineCollection(load, options) }; export const articles = make()",
  "const options: { route?: false } = { route: false }; options.route = undefined; export const articles = defineCollection(load, options)",
  "const { route } = { route: undefined }; export const articles = defineCollection(load, { route })",
  "const usePrivate = false; export const articles = usePrivate ? defineCollection(load, { route: false }) : defineCollection(load, {})",
  "export const articles = ((first, second) => second)(defineCollection(load, { route: false }), defineCollection(load, {}))",
  "export const articles = (() => { const unused = defineCollection(load, { route: false }); return defineCollection(load, {}) })()",
  "let route: false | undefined = false; route = undefined; export const articles = defineCollection(load, { route })",
  "var route = false; route = undefined; export const articles = defineCollection(load, { route })",
  "const options = { route: false }; export const articles = (() => { const options = {}; return defineCollection(load, options) })()",
  "const route = false; export const articles = ((route) => defineCollection(load, { route }))(undefined)",
  "const route = false; export const articles = (() => { let route = false; route = undefined; return defineCollection(load, { route }) })()",
  "const options = { route: false }; function make() { const options = {}; return defineCollection(load, options) }; export const articles = make()",
  "const prefix = 'rou'; export const articles = defineCollection(load, { [`${prefix}${prefix}`]: false })",
  "export const articles = defineCollection(load, { route: false, ...{ route: undefined } })",
  "const key = 'cache'; export const articles = defineCollection(load, { [key]: false })",
  "export const articles = other; const unrelated = defineCollection(load, { route: false })",
  "export const articles = other\nconst unrelated = defineCollection(load, { route: false })",
  "export const articles = other, unrelated = defineCollection(load, { route: false })",
  "const articles = other; export { articles }; const unrelated = defineCollection(load, { route: false })",
  "export const articles = other\ndefineCollection(load, { route: false })",
])("keeps unrelated later route metadata out of %s", async (source) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "source-routes-"))
  try {
    await mkdir(join(projectRoot, "server/collections"), { recursive: true })
    await writeFile(join(projectRoot, "server/collections/articles.ts"), source)
    const handlers = await prepareSourceGeneration({ projectRoot })
    expect(handlers.map(handler => handler.route)).toEqual(["/api/articles"])
  }
  finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

it.each([
  "import { defineCollection as makeCollection } from 'vite-hub/source'; export const articles = makeCollection(load, { route: false })",
  "import * as source from '@vite-hub/source'; export const articles = source.defineCollection(load, { route: false })",
  "function make(options = { route: false }) { return defineCollection(load, options) }; export const articles = make()",
  "function make(options = { route: false }) { return defineCollection(load, options) }; export const articles = make(undefined)",
  "const hidden = { route: false }; if (false) hidden.route = undefined; export const articles = defineCollection(load, hidden)",
  "const hidden = { route: false }; function unused() { hidden.route = undefined }; export const articles = defineCollection(load, hidden)",
  "const hidden = { route: false }; if (dynamic) hidden.route = undefined; export const articles = defineCollection(load, hidden)",
  "let route = true; route = false; export const articles = defineCollection(load, { route })",
  "var route = true; route = false; export const articles = defineCollection(load, { route })",
  "const { route } = { route: false }; export const articles = defineCollection(load, { route })",
  "const { route: hidden } = { route: false }; export const articles = defineCollection(load, { route: hidden })",
  "const options = {}; options.route = false; export const articles = defineCollection(load, options)",
  "const usePrivate = true; export const articles = usePrivate ? defineCollection(load, { route: false }) : defineCollection(load, {})",
  "export const articles = ((route) => defineCollection(load, { route }))(false)",
  "const route = false; export const articles = (() => { const { route } = external; return defineCollection(load, { route }) })()",
  "const options = {}; export const articles = (() => { const options = { route: false }; return defineCollection(load, options) })()",
  "const route = undefined; export const articles = (() => { const route = false; return defineCollection(load, { route }) })()",
  "const options = {}; function make() { const options = { route: false }; return defineCollection(load, options) }; export const articles = make()",
  "const options = { route: false }; export const articles = defineCollection(load, { ...options })",
  "export const articles = defineCollection(load, { ...unknownOptions, route: false })",
  "const key = 'route'; export const articles = defineCollection(load, { [key]: false })",
  "export const articles = (() => { const value = 1; return defineCollection(load, { route: false }) })()",
  "const $articles = ((defineCollection(load, { route: false }))); export { $articles as articles }",
  "export { articles }; const articles: Collection<Row> = defineCollection(load, { route: false })",
  "export const articles =\n defineCollection(load, { route: false })",
  "function make() { function setRoute() { options.route = false }; setRoute(); return defineCollection(load, options) }; const options = {}; export const articles = make()",
  "const options = {}; function privateA() { options.route = false }; function privateB() { options.route = false }; function make() { dynamic ? privateA() : privateB(); return defineCollection(load, options) }; export const articles = make()",
  "let enabled = true; const options = {}; if (enabled) { enabled = false; options.route = false }; export const articles = defineCollection(load, options)",
])("preserves nested and indirect route opt-outs in %s", async (source) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "source-routes-"))
  try {
    await mkdir(join(projectRoot, "server/collections"), { recursive: true })
    await writeFile(join(projectRoot, "server/collections/articles.ts"), source)
    expect(await prepareSourceGeneration({ projectRoot })).toEqual([])
  }
  finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

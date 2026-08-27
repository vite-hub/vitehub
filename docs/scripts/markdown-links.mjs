import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import GithubSlugger from "github-slugger";
import { decode } from "html-entities";
import remarkGfm from "remark-gfm";
import remarkMdc from "remark-mdc";
import remarkParse from "remark-parse";
import ts from "typescript";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";

const siteOrigin = "https://vitehub.dev";
const contentCollectionPrefixes = new Map([
  ["blog", "blog"],
  ["docs", "docs"],
  ["trust", ""],
]);

function walk(directory, predicate) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path, predicate) : predicate(path) ? [path] : [];
    });
}

function parseMarkdown(markdown, { renderer = "mdc" } = {}) {
  const parser = unified().use(remarkParse).use(remarkGfm);
  if (renderer === "mdc") parser.use(remarkMdc);
  return parser.runSync(parser.parse(markdown));
}

function visit(node, callback) {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

function nodeText(node) {
  if (node.type === "html") return node.value.replace(/<[^>]*>/g, "");
  if (node.value?.constructor === String) return node.value;
  if (node.type === "image") return node.alt ?? "";
  return (node.children ?? []).map(nodeText).join("");
}

function rawMarkdownSlug(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .replace(/ /g, "-");
}

function markdownSlug(value) {
  return value
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/^(\d)/, "_$1");
}

function htmlAttribute(tag, attributeName) {
  const attributes = tag.slice(tag.search(/\s/));
  for (const match of attributes.matchAll(/\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    if (match[1].toLowerCase() === attributeName) {
      return decode(match[2] ?? match[3] ?? match[4] ?? "", { scope: "attribute" });
    }
  }
  return undefined;
}

function withoutHtmlComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, "");
}

function htmlTags(value) {
  return withoutHtmlComments(value).match(/<[a-z][^'">]*(?:"[^"]*"|'[^']*'|[^'">]*)*>/gi) ?? [];
}

function sourceSetLinks(value) {
  const asciiWhitespace = /[ \t\n\f\r]/;
  const links = [];
  let position = 0;
  while (position < value.length) {
    while (asciiWhitespace.test(value[position] ?? "") || value[position] === ",") position += 1;
    const start = position;
    while (position < value.length && !asciiWhitespace.test(value[position])) position += 1;
    let url = value.slice(start, position);
    const trailingCommas = url.match(/,+$/)?.[0].length ?? 0;
    if (trailingCommas) url = url.slice(0, -trailingCommas);
    if (url) links.push(url);
    if (trailingCommas) continue;
    let parentheses = 0;
    while (position < value.length) {
      const character = value[position++];
      if (character === "(") parentheses += 1;
      else if (character === ")") parentheses = Math.max(0, parentheses - 1);
      else if (character === "," && parentheses === 0) break;
    }
  }
  return links;
}

function frontmatterLinks(frontmatter) {
  const value = parseYaml(frontmatter);
  if (value?.constructor !== Object) return [];
  const links = [];
  if (value.image?.constructor === String) links.push(value.image);
  for (const link of value.links ?? []) {
    if (link?.to?.constructor === String) links.push(link.to);
  }
  for (const author of value.authors ?? []) {
    if (author?.avatar?.src?.constructor === String) links.push(author.avatar.src);
    if (author?.to?.constructor === String) links.push(author.to);
  }
  return links;
}

function splitFrontmatter(markdown) {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  return match
    ? { body: markdown.slice(match[0].length), frontmatter: match[1] }
    : { body: markdown, frontmatter: undefined };
}

export function markdownAnchors(markdown, { renderer = "mdc" } = {}) {
  const anchors = new Set();
  const occurrences = new Map();
  const githubSlugger = new GithubSlugger();
  const { body } = splitFrontmatter(markdown);
  visit(parseMarkdown(body, { renderer }), (node) => {
    if (node.type === "html") {
      for (const tag of htmlTags(node.value)) {
        if (renderer === "mdc") {
          const id = htmlAttribute(tag, "id");
          if (id) anchors.add(id);
        }
        if (/^<a(?:\s|>)/i.test(tag)) {
          const name = htmlAttribute(tag, "name");
          if (name) anchors.add(name);
        }
      }
    }
    if (node.type !== "heading") return;
    if (renderer === "github") {
      const anchor = githubSlugger.slug(nodeText(node));
      if (anchor) anchors.add(anchor);
      return;
    }
    const rawBase = rawMarkdownSlug(nodeText(node));
    if (!rawBase) return;
    const base = markdownSlug(rawBase);
    if (!base) return;
    let anchor = base;
    while (occurrences.has(anchor)) {
      const count = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, count);
      anchor = `${base}-${count}`;
    }
    anchors.add(anchor);
    occurrences.set(anchor, 0);
  });
  return anchors;
}

export function markdownLinks(markdown, { renderer = "mdc" } = {}) {
  const { body, frontmatter } = splitFrontmatter(markdown);
  const tree = parseMarkdown(body, { renderer });
  const definitions = new Map();
  const links = [];
  visit(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  visit(tree, (node) => {
    if (node.type === "link" || node.type === "image") links.push(node.url);
    if (node.type === "linkReference" || node.type === "imageReference") {
      const destination = definitions.get(node.identifier);
      if (destination) links.push(destination);
    }
    if (node.type === "containerComponent" || node.type === "leafComponent" || node.type === "textComponent") {
      for (const attribute of ["to", "href", "src"]) {
        const destination = node.fmAttributes?.[attribute] ?? node.attributes?.[attribute];
        if (destination?.constructor === String) links.push(destination);
      }
    }
    if (node.type === "html") {
      const resourceAttributes = {
        a: ["href"],
        audio: ["src"],
        embed: ["src"],
        iframe: ["src"],
        img: ["src", "srcset"],
        input: ["src"],
        link: ["href"],
        object: ["data"],
        script: ["src"],
        source: ["src", "srcset"],
        track: ["src"],
        video: ["poster", "src"],
      };
      for (const rawTag of htmlTags(node.value)) {
        const tag = rawTag.match(/^<([a-z]+)/i)?.[1].toLowerCase();
        if (!tag) continue;
        for (const attribute of resourceAttributes[tag] ?? []) {
          const destination = htmlAttribute(rawTag, attribute);
          if (!destination) continue;
          if (attribute === "srcset") links.push(...sourceSetLinks(destination));
          else links.push(destination);
        }
      }
    }
  });
  if (frontmatter) links.push(...frontmatterLinks(frontmatter));
  return links;
}

function staticBinding(value, constants = new Map()) {
  if (value && /^[A-Za-z_$][\w$]*$/.test(value)) return constants.get(value);
  const quote = value?.[0];
  if ((quote === "\"" || quote === "'") && value.at(-1) === quote) {
    const destination = value.slice(1, -1);
    return destination.includes("\\") ? undefined : destination;
  }
  if (!value?.trimStart().startsWith("{")) return undefined;
  const file = ts.createSourceFile("binding.ts", `const binding = (${value})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const initializer = file.statements[0]?.declarationList?.declarations?.[0]?.initializer;
  if (!ts.isParenthesizedExpression(initializer) || !ts.isObjectLiteralExpression(initializer.expression)) return undefined;
  const path = initializer.expression.properties.find((property) => ts.isPropertyAssignment(property)
    && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === "path");
  if (!path || !ts.isPropertyAssignment(path)) return undefined;
  return ts.isStringLiteralLike(path.initializer)
    ? path.initializer.text
    : ts.isIdentifier(path.initializer) ? constants.get(path.initializer.text) : undefined;
}

function isStaticSiteDestination(destination) {
  return destination.startsWith("#")
    || /^(?:https?:)?\/\//i.test(destination)
    || !/^[a-z][a-z\d+.-]*:/i.test(destination);
}

function vueLinks(source) {
  const links = [];
  const constants = new Map();
  const dynamicProperties = vueLinkProperties(source);
  const propertyNames = new Set(["to", "href", "src", "poster", "srcset", ...dynamicProperties.keys()]);
  for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    links.push(...typescriptLinks(match[1], { propertyNames, scopedProperties: dynamicProperties }));
    const file = ts.createSourceFile("component.ts", match[1], ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)) {
          constants.set(declaration.name.text, declaration.initializer.text);
        }
      }
    }
  }
  const templateSource = withoutHtmlComments(source)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  for (const tag of htmlTags(templateSource)) {
    for (const attribute of ["to", "href", "src", "poster", "srcset"]) {
      const staticDestination = htmlAttribute(tag, attribute);
      const boundDestination = staticBinding(htmlAttribute(tag, `:${attribute}`), constants);
      for (const destination of [staticDestination, boundDestination]) {
        if (!destination) continue;
        const resource = ["src", "poster", "srcset"].includes(attribute);
        if (attribute === "srcset") links.push(...sourceSetLinks(destination).map((value) => ({ destination: value, resource })));
        else links.push({ destination, resource });
      }
    }
  }
  const normalizedLinks = links.map((link) => link?.constructor === String ? { destination: link, resource: false } : link);
  return [...new Map(normalizedLinks.filter(({ destination }) => isStaticSiteDestination(destination))
    .map((link) => [`${link.resource}:${link.destination}`, link])).values()];
}

function typescriptLinks(source, { exportNames, propertyNames, scopedProperties = new Map() } = {}) {
  const links = [];
  const file = ts.createSourceFile("application.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const linkProperties = propertyNames ?? new Set(["to", "href", "src", "poster", "srcset"]);
  const constants = new Map();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)) {
        constants.set(declaration.name.text, declaration.initializer.text);
      }
    }
  }
  function collect(node) {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)
        ? node.name.text
        : undefined;
      if (linkProperties.has(name)) {
        const destination = ts.isStringLiteralLike(node.initializer)
          ? node.initializer.text
          : ts.isIdentifier(node.initializer) ? constants.get(node.initializer.text) : undefined;
        if (destination) links.push(destination);
      }
    }
    ts.forEachChild(node, collect);
  }
  if (!exportNames || exportNames.has("*")) {
    if (!scopedProperties.size) {
      collect(file);
      return [...new Set(links.filter(isStaticSiteDestination))];
    }
    const unscopedProperties = new Set([...linkProperties].filter((name) => !scopedProperties.has(name)));
    const originalProperties = new Set(linkProperties);
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const selectedProperties = new Set(unscopedProperties);
        for (const [property, roots] of scopedProperties) {
          if (roots.has(declaration.name.text)) selectedProperties.add(property);
        }
        if (!selectedProperties.size) continue;
        linkProperties.clear();
        for (const property of selectedProperties) linkProperties.add(property);
        collect(declaration.initializer);
      }
    }
    linkProperties.clear();
    for (const property of originalProperties) linkProperties.add(property);
  }
  else {
    for (const statement of file.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && exportNames.has(declaration.name.text) && declaration.initializer) {
            collect(declaration.initializer);
          }
        }
      }
      else if (exportNames.has("default") && ts.isExportAssignment(statement)) {
        collect(statement.expression);
      }
      else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
        && ((statement.name && exportNames.has(statement.name.text))
          || (exportNames.has("default") && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)))) {
        collect(statement);
      }
    }
  }
  return [...new Set(links.filter(isStaticSiteDestination))];
}

function applicationImports(source, extension) {
  const templateSource = extension === ".vue"
    ? withoutHtmlComments(source).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    : undefined;
  const scripts = extension === ".vue"
    ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1])
    : [source];
  return scripts.flatMap((script) => {
    const file = ts.createSourceFile("application.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return file.statements.flatMap((statement) => {
      if (ts.isExportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const names = statement.exportClause && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements.map((element) => ({
              imported: element.propertyName?.text ?? element.name.text,
              local: element.name.text,
            }))
          : [{ imported: "*", local: "*" }];
        return [{ names, specifier: statement.moduleSpecifier.text }];
      }
      if (!ts.isImportDeclaration(statement) || !statement.importClause
        || !ts.isStringLiteralLike(statement.moduleSpecifier)) return [];
      const names = [];
      if (statement.importClause.name) {
        names.push({ imported: "default", local: statement.importClause.name.text });
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        names.push(...bindings.elements.map((element) => ({
          imported: element.propertyName?.text ?? element.name.text,
          local: element.name.text,
        })));
      }
      else if (bindings && ts.isNamespaceImport(bindings)) {
        names.push({ imported: "*", local: bindings.name.text });
      }
      const renderedNames = templateSource === undefined
        ? names
        : names.filter(({ local }) => new RegExp(`\\b${local}\\b`).test(templateSource));
      return renderedNames.length ? [{ names: renderedNames, specifier: statement.moduleSpecifier.text }] : [];
    });
  });
}

function vueLinkProperties(source) {
  const properties = new Map();
  const templateSource = withoutHtmlComments(source)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  for (const tag of htmlTags(templateSource)) {
    for (const attribute of ["to", "href", "src", "poster", "srcset"]) {
      const binding = htmlAttribute(tag, `:${attribute}`);
      const expression = binding && !staticBinding(binding)
        ? binding.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*$/)
        : undefined;
      if (!expression) continue;
      const [, alias, property] = expression;
      const sourceName = templateSource.match(new RegExp(`\\bv-for=["'][^"']*\\b${alias}\\s+in\\s+([A-Za-z_$][\\w$]*)`))?.[1];
      if (!sourceName) continue;
      if (!properties.has(property)) properties.set(property, new Set());
      properties.get(property).add(sourceName);
    }
  }
  return properties;
}

function routeFromContentPath(contentRoot, path) {
  const parts = relative(contentRoot, path).split(sep);
  const collection = parts.shift();
  if (!contentCollectionPrefixes.has(collection)) return undefined;
  const clean = collection === "docs" ? parts : parts.map((part) => part.replace(/^\d+\./, ""));
  clean[clean.length - 1] = clean.at(-1).replace(/\.md$/, "");
  if (clean.at(-1) === "index") clean.pop();
  const prefix = contentCollectionPrefixes.get(collection);
  return normalizeRoute(`/${[prefix, ...clean].filter(Boolean).join("/")}`);
}

function normalizeRoute(route) {
  const normalized = route.replace(/\/{2,}/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

function normalizeRenderedRoute(route) {
  return route.length > 1 ? route.replace(/\/+$/, "") || "/" : route;
}

function publicReadmes(repoRoot) {
  const packageReadmes = walk(join(repoRoot, "packages"), (path) => path.endsWith(`${sep}package.json`))
    .filter((packageJson) => !JSON.parse(readFileSync(packageJson, "utf8")).private)
    .map((packageJson) => join(dirname(packageJson), "README.md"))
    .filter(existsSync);
  return [join(repoRoot, "README.md"), ...packageReadmes].filter(existsSync);
}

function staticHtmlAnchors(source) {
  return new Set(htmlTags(source).map((tag) => htmlAttribute(tag, "id")).filter(Boolean));
}

function supportMatrixAnchors(docsRoot) {
  const path = join(docsRoot, "app/components/SupportMatrix.vue");
  if (!existsSync(path)) return undefined;
  const source = readFileSync(path, "utf8");
  const anchors = staticHtmlAnchors(source);
  for (const match of source.matchAll(/\banchor\s*:\s*["']([^"']+)["']/g)) anchors.add(match[1]);
  return anchors;
}

function isStaticApplicationRoute(route) {
  return !route.split("/").some((segment) => segment.includes("[") || segment.includes("]"));
}

function applicationInventory(docsRoot) {
  const appRoot = join(docsRoot, "app");
  const pagesRoot = join(docsRoot, "app/pages");
  const componentsRoot = join(docsRoot, "app/components");
  const componentFiles = walk(componentsRoot, (path) => path.endsWith(".vue"));
  const components = new Map(componentFiles.map((path) => {
    const name = relative(componentsRoot, path).replace(/\.vue$/, "").split(sep)
      .map((part) => part.replace(/(^|-)(\w)/g, (_, _separator, letter) => letter.toUpperCase())).join("");
    return [name, path];
  }));
  const sourceRoutes = new Map();
  const importedFiles = new Set();
  const importedNames = new Map();
  const importedProperties = new Map();
  function resolveImport(sourcePath, specifier) {
    if (!specifier.startsWith(".") && !specifier.startsWith("~/")) return undefined;
    const unresolved = specifier.startsWith("~/")
      ? resolve(appRoot, specifier.slice(2))
      : resolve(dirname(sourcePath), specifier);
    const candidates = [
      unresolved,
      `${unresolved}.ts`,
      `${unresolved}.vue`,
      join(unresolved, "index.ts"),
      join(unresolved, "index.vue"),
    ];
    return candidates.find((candidate) => candidate.startsWith(`${appRoot}${sep}`)
      && existsSync(candidate) && statSync(candidate).isFile());
  }
  const routeAnchors = new Map(walk(pagesRoot, (path) => path.endsWith(".vue")).flatMap((path) => {
    const route = relative(join(docsRoot, "app/pages"), path)
      .split(sep).join("/").replace(/\.vue$/, "").replace(/\/index$/, "").replace(/^index$/, "");
    if (!isStaticApplicationRoute(route)) return [];
    const anchors = new Set();
    const pending = [path];
    const visited = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      if (!sourceRoutes.has(file)) sourceRoutes.set(file, new Set());
      sourceRoutes.get(file).add(normalizeRoute(`/${route}`));
      const source = readFileSync(file, "utf8");
      if (extname(file) === ".vue") {
        for (const anchor of staticHtmlAnchors(source)) anchors.add(anchor);
        const renderedSource = withoutHtmlComments(source);
        for (const [name, componentPath] of components) {
          const kebabName = name.replace(/\B([A-Z])/g, "-$1").toLowerCase();
          if (new RegExp(`<(?:${name}|${kebabName})(?:\\s|/|>)`).test(renderedSource)) pending.push(componentPath);
        }
      }
      const linkProperties = extname(file) === ".vue"
        ? new Set(vueLinkProperties(source).keys())
        : importedProperties.get(file) ?? new Set();
      for (const applicationImport of applicationImports(source, extname(file))) {
        const { specifier } = applicationImport;
        const selectedNames = importedNames.get(file);
        const exportAll = applicationImport.names.some(({ local }) => local === "*");
        const names = exportAll && selectedNames && !selectedNames.has("*")
          ? [...selectedNames].map((name) => ({ imported: name, local: name }))
          : extname(file) === ".vue" || !selectedNames
            ? applicationImport.names
            : applicationImport.names.filter(({ local }) => selectedNames.has("*") || selectedNames.has(local));
        if (!names.length) continue;
        const importedPath = resolveImport(file, specifier);
        if (importedPath) {
          importedFiles.add(importedPath);
          if (!importedNames.has(importedPath)) importedNames.set(importedPath, new Set());
          if (!importedProperties.has(importedPath)) importedProperties.set(importedPath, new Set());
          for (const { imported } of names) importedNames.get(importedPath).add(imported);
          for (const property of linkProperties) importedProperties.get(importedPath).add(property);
          pending.push(importedPath);
        }
      }
    }
    return [[normalizeRoute(`/${route}`), anchors]];
  }));
  for (const path of walk(join(docsRoot, "server/routes"), (path) => path.endsWith(".ts"))) {
    const route = relative(join(docsRoot, "server/routes"), path).split(sep).join("/").replace(/\.ts$/, "");
    if (isStaticApplicationRoute(route)) routeAnchors.set(normalizeRoute(`/${route}`), new Set());
  }
  for (const route of ["/llms.txt", "/llms-full.txt", "/mcp"]) routeAnchors.set(route, new Set());
  const matrixAnchors = supportMatrixAnchors(docsRoot);
  if (matrixAnchors) routeAnchors.set("/docs/frameworks-hosts/support-matrix", matrixAnchors);
  return { importedFiles, importedNames, importedProperties, routeAnchors, sourceRoutes };
}

function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function splitDestination(destination) {
  const hash = destination.indexOf("#");
  const fragment = hash === -1 ? "" : decodeFragment(destination.slice(hash + 1));
  const path = (hash === -1 ? destination : destination.slice(0, hash)).split("?")[0];
  return { fragment, path };
}

export function docsManifestRoutes(manifest) {
  return [
    manifest.rootPage?.path,
    ...manifest.sections.flatMap((section) => section.pages.map((page) => page.path)),
  ].filter(Boolean);
}

export function validateDocumentationLinks({ docsRoutes = [], repoRoot }) {
  const docsRoot = join(repoRoot, "docs");
  const contentRoot = join(docsRoot, "content");
  const publicRoot = join(docsRoot, "public");
  const contentFiles = walk(contentRoot, (path) => path.endsWith(".md"))
    .filter((path) => routeFromContentPath(contentRoot, path) !== undefined);
  const readmes = publicReadmes(repoRoot);
  const markdownFiles = [...contentFiles, ...readmes];
  const application = applicationInventory(docsRoot);
  const applicationFiles = [...new Set([
    ...walk(join(docsRoot, "app"), (path) => path.endsWith(".vue")),
    ...application.importedFiles,
  ])];
  const nuxtConfig = join(docsRoot, "nuxt.config.ts");
  const sourceEntries = [
    ...markdownFiles.map((sourcePath) => {
      const sourceRoute = sourcePath.startsWith(`${contentRoot}${sep}`)
        ? routeFromContentPath(contentRoot, sourcePath)
        : undefined;
      const renderer = sourceRoute === undefined ? "github" : "mdc";
      return {
        destinations: markdownLinks(readFileSync(sourcePath, "utf8"), { renderer }),
        renderer,
        sourcePath,
        sourceRoute,
      };
    }),
    ...applicationFiles.map((sourcePath) => ({
      destinations: extname(sourcePath) === ".vue"
        ? vueLinks(readFileSync(sourcePath, "utf8"))
        : typescriptLinks(readFileSync(sourcePath, "utf8"), {
            exportNames: application.importedNames.get(sourcePath),
            propertyNames: application.importedProperties.get(sourcePath),
          }),
      renderer: "vue",
      renderedRoutes: [...(application.sourceRoutes.get(sourcePath) ?? [])],
      sourcePath,
      sourceRoute: [...(application.sourceRoutes.get(sourcePath) ?? [])][0] ?? "/",
    })),
    ...(existsSync(nuxtConfig) ? [{
      destinations: typescriptLinks(readFileSync(nuxtConfig, "utf8")),
      renderer: "vue",
      sourcePath: nuxtConfig,
      sourceRoute: "/",
    }] : []),
  ];
  const routeFiles = new Map(contentFiles.map((path) => [routeFromContentPath(contentRoot, path), path]));
  const applicationRoutes = application.routeAnchors;
  const knownRoutes = new Set([...routeFiles.keys(), ...applicationRoutes.keys(), ...docsRoutes.map(normalizeRoute)]);
  for (const route of routeFiles.keys()) {
    if (route !== "/") knownRoutes.add(`/raw${route}.md`);
  }
  const anchors = new Map();
  function anchorsFor(path, renderer) {
    const key = `${renderer}:${path}`;
    if (!anchors.has(key)) anchors.set(key, markdownAnchors(readFileSync(path, "utf8"), { renderer }));
    return anchors.get(key);
  }
  const errors = [];
  let checked = 0;

  for (const { destinations, renderedRoutes = [], renderer, sourcePath, sourceRoute } of sourceEntries) {
    for (const link of destinations) {
      const { destination, resource = false } = link?.constructor === String ? { destination: link } : link;
      if (/^(?:mailto:|tel:|data:|javascript:)/i.test(destination)) continue;
      if (sourceRoute === undefined && /^\/(?!\/)/.test(destination)) continue;
      let local = destination;
      let isSiteLink = false;
      if (/^(?:https?:)?\/\//i.test(destination)) {
        const url = new URL(destination, siteOrigin);
        if (url.origin !== siteOrigin) continue;
        local = `${url.pathname}${url.search}${url.hash}`;
        isSiteLink = true;
      }
      if (/^[a-z][a-z\d+.-]*:/i.test(local)) continue;

      checked += 1;
      const { fragment, path } = splitDestination(local);
      if (resource && path && !path.startsWith("/") && !isSiteLink) {
        const assetFile = resolve(dirname(sourcePath), decodeFragment(path));
        const appRoot = join(docsRoot, "app");
        if (!assetFile.startsWith(`${appRoot}${sep}`) || !existsSync(assetFile) || !statSync(assetFile).isFile()) {
          errors.push(`${relative(repoRoot, sourcePath)}: resource ${JSON.stringify(path)} does not exist`);
        }
        continue;
      }
      if (!path && fragment && renderer === "vue") {
        for (const route of renderedRoutes) {
          const routeAnchors = applicationRoutes.get(route);
          if (!routeAnchors?.has(fragment)) {
            errors.push(`${relative(repoRoot, sourcePath)}: anchor #${fragment} does not exist for route ${JSON.stringify(route)}`);
          }
        }
        continue;
      }
      const sourceRoutes = renderer === "vue" && path && !path.startsWith("/") && renderedRoutes.length
        ? renderedRoutes
        : [sourceRoute];
      for (const resolvedSourceRoute of sourceRoutes) {
      let targetFile;
      let targetRoute;

      if (!path) {
        if (renderer === "vue") targetRoute = resolvedSourceRoute;
        else targetFile = sourcePath;
      } else if (sourceRoute !== undefined || isSiteLink) {
        const renderedPath = path.startsWith("/")
          ? path
          : new URL(path, `${siteOrigin}${resolvedSourceRoute ?? "/"}`).pathname;
        targetRoute = normalizeRenderedRoute(renderedPath);
        targetFile = routeFiles.get(targetRoute);
        if (!targetFile && !renderedPath.endsWith("/")) {
          const publicFile = resolve(publicRoot, `.${renderedPath}`);
          if (publicFile.startsWith(`${publicRoot}${sep}`) && existsSync(publicFile) && statSync(publicFile).isFile()) {
            targetFile = publicFile;
          }
        }
        if (!targetFile && !knownRoutes.has(targetRoute)) {
          errors.push(`${relative(repoRoot, sourcePath)}: route ${JSON.stringify(targetRoute)} does not exist (${destination})`);
          continue;
        }
      } else if (path.startsWith("/")) {
        targetFile = resolve(repoRoot, `.${path}`);
        if (!existsSync(targetFile)) {
          errors.push(`${relative(repoRoot, sourcePath)}: repository path ${JSON.stringify(path)} does not exist`);
          continue;
        }
      } else {
        const decodedPath = decodeFragment(path);
        targetFile = resolve(dirname(sourcePath), decodedPath);
        if (targetFile !== repoRoot && !targetFile.startsWith(`${repoRoot}${sep}`)) {
          errors.push(`${relative(repoRoot, sourcePath)}: file ${JSON.stringify(path)} is outside the repository`);
          continue;
        }
        if (!existsSync(targetFile)) {
          errors.push(`${relative(repoRoot, sourcePath)}: file ${JSON.stringify(path)} does not exist`);
          continue;
        }
      }

      if (fragment && targetFile) {
        if (statSync(targetFile).isDirectory()) {
          const readme = join(targetFile, "README.md");
          if (existsSync(readme)) targetFile = readme;
        }
        const targetRenderer = renderer === "github" && !isSiteLink ? "github" : "mdc";
        const targetAnchors = targetRoute === "/docs/frameworks-hosts/support-matrix"
          ? applicationRoutes.get(targetRoute)
          : extname(targetFile) === ".md"
            ? anchorsFor(targetFile, targetRenderer)
            : targetRoute ? applicationRoutes.get(targetRoute) : undefined;
        if (targetAnchors && !targetAnchors.has(fragment)) {
          errors.push(`${relative(repoRoot, sourcePath)}: anchor #${fragment} does not exist in ${relative(repoRoot, targetFile)}`);
        }
      } else if (fragment && targetRoute) {
        const routeAnchors = applicationRoutes.get(targetRoute);
        if (!routeAnchors?.has(fragment)) {
          errors.push(`${relative(repoRoot, sourcePath)}: anchor #${fragment} does not exist for route ${JSON.stringify(targetRoute)}`);
        }
      }
      }
    }
  }

  return { checked, errors, files: sourceEntries.length };
}

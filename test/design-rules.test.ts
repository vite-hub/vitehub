import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { createSourceFile, getLeadingCommentRanges, getTrailingCommentRanges, ScriptTarget } from "typescript"
import { describe, expect, it } from "vitest"
import { repoRoot, walkFiles } from "./utils/repo"
import type { Node } from "typescript"

/**
 * The rules of the ViteHub design system (docs/DESIGN.md) that code can check. The theme in @vite-hub/ui draws focus,
 * colors, and tabs once, so the surfaces that use it must not set their own.
 */
const surfaces = [
  "packages/vite-hub/src/console",
  "packages/docs/runtime",
  "packages/docs/src",
  "packages/ui/src",
  "packages/ui/styles.css",
  "packages/kit/src/styles",
  "docs/app",
  "playground",
]

// The theme itself, generated images, and files whose colors are data, such as brand logos.
const allowed = [
  "packages/ui/theme.css",
  // The kit tokens are the colors of its style families, as theme.css is for @vite-hub/ui.
  "packages/kit/src/styles/tokens.css",
  "packages/ui/src/theme.ts",
  "packages/docs/runtime/app/components/OgImage/",
  "packages/vite-hub/src/console/runtime/components/invocation/internal/brand-icons.ts",
  // The pages that the server renders before the Console app loads copy the tokens of theme.css, and a test keeps them equal.
  "packages/vite-hub/src/console/standalone-page.ts",
  "docs/app/data/brand-colors.ts",
  "docs/app/examples/",
]

// A kit style family is a theme for headless parts that have no Nuxt UI theme to draw focus, so it draws the one focus
// ring itself. It must still take every color from the tokens.
const focusThemes = ["packages/kit/src/styles/"]

const ignoreDirs = new Set([".nuxt", ".output", ".vitehub", "dist", "node_modules"])
const sourceFile = /\.(vue|ts|css)$/

interface Finding {
  file: string
  line: number
  rule: string
  text: string
}

const rules: Array<{ rule: string, pattern: RegExp }> = [
  // A Tailwind class that draws focus: an outline or a ring under a focus variant.
  { rule: "focus class", pattern: /(?:^|[\s"'`[])(?:[\w-]+:)*(?:focus|focus-visible|focus-within|has-focus-visible|group-focus-visible|peer-focus-visible)(?::[\w[\]&>=-]+)*:(?:outline|ring)(?:-[\w/[\]().-]+)?(?=[\s"'`\]]|$)/ },
  // A CSS rule that draws focus.
  { rule: "focus css", pattern: /:focus(?:-visible|-within)?\b[^{]*\{[^}]*(?:outline|box-shadow)\s*:/ },
  // A color literal, also inside a Tailwind arbitrary value such as `shadow-[0_1px_rgb(0_0_0/4%)]`. Colors come from the theme tokens.
  { rule: "color literal", pattern: /(?<![\w&/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b(?![\w-])|(?:\b|(?<=_))(?:rgb|rgba|hsl|hsla|oklch)\(\s*\d/ },
  // A tab strip built by hand. UTabs has the keyboard behavior and the theme's underline.
  { rule: "hand-made tabs", pattern: /role=["']tab(?:list)?["']|role:\s*["']tab(?:list)?["']/ },
]

/**
 * Hand-written motion (docs/design/motion.md): motion comes from the motion layer of `@vite-hub/ui/motion` or from a
 * motion helper, never from code of its own. The rule reads the design surfaces and the plain TypeScript UI of the page
 * pill, the page tools, and the comments overlay.
 *
 * It finds motion that moves, resizes, or shakes: `@keyframes` and `animation` that change `transform`, position, or
 * size, transitions on `transform`, `scale`, `translate`, `rotate`, size, position, `margin`, `clip-path`, grid tracks, or
 * `all` (also when the declaration spans lines, and in style strings and `style.setProperty`), the Tailwind classes
 * `transition-transform`, `transition-all`, `animate-*`, hover or press `scale-*`, and the plain `transition` class next
 * to a state class that turns or moves, as in `transition group-open:rotate-90`, Vue `<Transition>` classes that
 * move, WAAPI `.animate()` calls that move, and `requestAnimationFrame` loops that write styles.
 *
 * Color and opacity fades are not motion. A loading spinner that turns forever (`animate-spin`, or `@keyframes` that only
 * rotate) and a skeleton pulse (`animate-pulse`) show that work runs, so they are allowed too.
 */
const motionSurfaces = [
  ...surfaces,
  "packages/ui/theme.css",
  "packages/ui/comment-marks.css",
  "packages/ui/icon-swap.css",
  "packages/kit/src",
  "packages/internal/src/runtime",
  "packages/comments/src",
  "packages/vite-hub/src/page",
]

const motionExempt = [
  // The motion layer itself.
  "packages/ui/src/motion/",
  "packages/ui/src/motion.ts",
]

/**
 * Own-motion figures: surfaces that draw their own picture, as a canvas or a chart does, and are not controls. Each sets
 * `data-motion="none"` on its root (docs/design/motion.md), so the motion layer skips it, and the rule skips its files.
 * A control, a label, a list, or a disclosure next to a figure still gets its motion from the layer. Keep this list as
 * short as the truth allows, and give each entry its reason.
 */
const ownMotionFigures: Array<{ path: string, reason: string }> = [
  {
    path: "docs/app/utils/hero-figure/",
    reason: "The hero figure of a primitive page plays a timeline of the primitive's story (code runs, rows appear, jobs retry) in a `role=\"img\"` stage with `data-motion=\"none\"`. Nothing in it is a control. Its caption and its pause button are outside the stage and use the layer.",
  },
  {
    path: "docs/app/assets/hero-figure.css",
    reason: "The styles of the same hero figure scenes.",
  },
]

type Wave = "W2" | "W3" | "W4" | "W5"

/**
 * Hand-written motion that exists today, by file, with the wave of the motion plan that moves it onto the layer or a
 * helper. A new spot in a listed file fails, and a removed spot fails until its count goes down. W5 empties this list.
 */
const motionAllowlist: Record<string, { count: number, wave: Wave }> = {
  // W5: the Console.
  "packages/vite-hub/src/console/runtime/components/console-app.vue": { count: 1, wave: "W5" },
  "packages/vite-hub/src/console/runtime/components/console-auth-chart.vue": { count: 1, wave: "W5" },
  "packages/vite-hub/src/console/runtime/components/console-auth.vue": { count: 1, wave: "W5" },
  "packages/vite-hub/src/console/runtime/components/console-search-palette.vue": { count: 3, wave: "W5" },
  "packages/vite-hub/src/console/runtime/components/console-sidebar.vue": { count: 1, wave: "W5" },
  "packages/vite-hub/src/console/runtime/components/console-usage-chart.vue": { count: 1, wave: "W5" },
  "packages/vite-hub/src/console/runtime/components/invocation/invocation.css": { count: 10, wave: "W5" },
  "packages/vite-hub/src/console/standalone-page.ts": { count: 2, wave: "W5" },
  // W5: @vite-hub/ui parts, the page pill and tools, and the comments overlay.
  "packages/comments/src/overlay/styles.ts": { count: 8, wave: "W5" },
  "packages/internal/src/runtime/page-pill.ts": { count: 12, wave: "W5" },
  "packages/internal/src/runtime/page-tools-loader.ts": { count: 7, wave: "W5" },
  "packages/internal/src/runtime/page-tools-shared.ts": { count: 2, wave: "W5" },
  "packages/internal/src/runtime/page-tools-window.ts": { count: 1, wave: "W5" },
  "packages/ui/comment-marks.css": { count: 7, wave: "W5" },
  "packages/ui/icon-swap.css": { count: 1, wave: "W5" },
  "packages/ui/styles.css": { count: 28, wave: "W5" },
}

const motionProperty = /^(?:transform|translate|scale|rotate|all|(?:min-|max-)?(?:width|height)|inset|top|right|bottom|left|margin(?:-\w+)?|clip-path|grid-template-(?:rows|columns)|flex-basis)$/
const motionDeclaration = /(?:^|[\s;{])(?:transform|translate|scale|rotate|(?:min-|max-)?(?:width|height)|inset|top|right|bottom|left|margin(?:-\w+)?|clip-path)\s*:/

function cssWithoutComments(file: string, text: string): string {
  const blank = (match: string) => match.replace(/[^\r\n]/g, " ")
  let result = text.replace(/\/\*[\s\S]*?\*\//g, blank)
  if (file.endsWith(".vue")) result = result.replace(/<!--[\s\S]*?-->/g, blank).replace(/^\s*\/\/.*$/gm, blank)
  return result
}

/** The text between the bracket at `open` and its partner, or the rest of the text. */
function balanced(text: string, open: number): string {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" }
  const close = pairs[text[open]!]!
  let depth = 0
  for (let index = open; index < text.length; index++) {
    if (text[index] === text[open]) depth++
    else if (text[index] === close && --depth === 0) return text.slice(open + 1, index)
  }
  return text.slice(open + 1)
}

/** The parts of a list at depth 0, such as the transitions of `opacity 1s, transform 1s cubic-bezier(0, 0, 1, 1)`. */
function splitList(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "(") depth++
    else if (value[index] === ")") depth--
    else if (value[index] === "," && depth === 0) {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  return [...parts, value.slice(start)].map(part => part.trim()).filter(Boolean)
}

/** True when a `transition` value animates a property that moves. A value that starts with a duration animates `all`. */
function transitionMoves(value: string): boolean {
  return splitList(value).some((part) => {
    const first = part.split(/\s+/)[0]!
    return motionProperty.test(first) || /^[\d.]+m?s$/.test(first)
  })
}

/** True when the frames of a `@keyframes` rule move. Frames that only turn, as a spinner does, do not count. */
function keyframesMove(body: string): boolean {
  const declarations = [...body.matchAll(/([\w-]+)\s*:\s*([^;}]+)/g)].map(([, property, value]) => [property!, value!.trim()])
  const spinner = declarations.length > 0 && declarations.every(([property, value]) => property === "rotate" || (property === "transform" && /^rotate\([^)]*\)$/.test(value!)))
  return !spinner && motionDeclaration.test(body)
}

/** Every `@keyframes` rule of the motion surfaces, by name, and whether it moves. Tailwind's own come first. */
function collectKeyframes(texts: Array<[string, string]>): Map<string, boolean> {
  const keyframes = new Map([["spin", false], ["pulse", false], ["ping", true], ["bounce", true]])
  for (const [file, text] of texts) {
    for (const match of cssWithoutComments(file, text).matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
      keyframes.set(match[1]!, keyframesMove(balanced(match.input, match.index + match[0].length - 1)))
    }
  }
  return keyframes
}

const animationKeywords = new Set(["none", "initial", "inherit", "unset", "infinite", "linear", "ease", "ease-in", "ease-out", "ease-in-out", "forwards", "backwards", "both", "alternate", "alternate-reverse", "reverse", "normal", "running", "paused", "step-start", "step-end"])

/** True when an `animation` value plays keyframes that move, or keyframes that no motion surface defines. */
function animationMoves(value: string, keyframes: Map<string, boolean>): boolean {
  const names = value.split(/[\s,_]+/).filter(token => /^[a-z][\w-]*$/i.test(token) && !animationKeywords.has(token) && !/^(?:cubic-bezier|steps|var)$/.test(token))
  if (!names.length) return false
  const known = names.filter(name => keyframes.has(name))
  return known.length ? known.some(name => keyframes.get(name)) : true
}

/**
 * Every declaration of `property` (`transition` or `animation`) with its value, in each form the surfaces write it:
 * - CSS, also in a `<style>` block, an inline `style` string, or a template string. A value can span lines, as in
 *   `transition:\n  opacity 1s,\n  transform 1s`, and ends at `;`, `{`, `}`, a quote, or a line that starts a new key.
 * - A quoted value in script or a template binding, as in `{ transition: 'transform 1s' }`. It ends at its quote.
 * - An assignment in script, as in `el.style.transition = value`. It ends at the end of its line.
 * - `style.setProperty("transition", "transform 1s")`.
 */
function declarations(source: string, property: "transition" | "animation"): Array<{ index: number, text: string, value: string }> {
  const long = property === "transition" ? "-property" : "-name"
  const camel = property === "transition" ? "Property" : "Name"
  const name = `(?<![\\w-])${property}(?:${long}|${camel})?`
  const forms = [
    new RegExp(`${name}\\s*:\\s*(?![\\s"'\`])((?:(?!\\n\\s*[\\w-]+\\s*:)[^;{}"'\`])+)`, "g"),
    new RegExp(`${name}\\s*[:=]\\s*(["'\`])((?:(?!\\1)[^\\\\]|\\\\[\\s\\S])*)\\1`, "g"),
    new RegExp(`${name}\\s*=\\s*(?![\\s"'\`])([^;{}"'\`\\n]+)`, "g"),
    new RegExp(`setProperty\\(\\s*["'\`]${property}(?:${long})?["'\`]\\s*,\\s*["'\`]([^"'\`]*)`, "g"),
  ]
  return forms.flatMap(form => [...source.matchAll(form)].map(match => ({ index: match.index, text: match[0], value: match.at(-1)! })))
}

/** True when a function named `name` in `source` asks for the next frame with itself, as a frame loop does. */
function selfScheduling(source: string, name: string): boolean {
  const declaration = new RegExp(`(?:function\\s+${name}\\s*\\([^)]*\\)\\s*|\\b${name}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|\\w+)\\s*=>\\s*)\\{`).exec(source)
  if (!declaration) return false
  return new RegExp(`requestAnimationFrame\\(\\s*${name}\\s*\\)`).test(balanced(source, declaration.index + declaration[0].length - 1))
}

function scanMotion(file: string, text: string, keyframes: Map<string, boolean>): Finding[] {
  const source = cssWithoutComments(file, withoutComments(file, text))
  const findings: Finding[] = []
  const add = (index: number, text: string) => findings.push({ file, line: source.slice(0, index).split("\n").length, rule: "hand-written motion", text: text.trim().replace(/\s+/g, " ").slice(0, 80) })

  for (const match of source.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    if (keyframes.get(match[1]!)) add(match.index, match[0])
  }
  for (const { index, text, value } of declarations(source, "animation")) {
    if (animationMoves(value, keyframes)) add(index, text)
  }
  for (const { index, text, value } of declarations(source, "transition")) {
    if (transitionMoves(value)) add(index, text)
  }
  // Tailwind classes, with any variants in front.
  for (const match of source.matchAll(/(?<![\w-])(?:[\w\-[\]&=>.*()@/]+:)*transition-(?:transform|all|\[([^\]\s]+)\])(?![\w-])/g)) {
    if (match[1] === undefined || splitList(match[1].replace(/_/g, " ")).some(property => motionProperty.test(property))) add(match.index, match[0])
  }
  // Tailwind's plain `transition` class also animates `transform`, `translate`, `scale`, and `rotate`, so it moves when the
  // same class list turns or moves the element under a state, as in `transition group-open:rotate-90`.
  for (const match of source.matchAll(/(["'`])((?:(?!\1)[^\\]|\\[\s\S])*)\1/g)) {
    const plain = /(?<![\w\-:[])(?:[\w\-[\]&=>.*()@/]+:)*transition(?![\w\-:[])/.exec(match[2]!)
    if (plain && /(?<![\w-])(?:[\w\-[\]&=>.*()@/]+:)+-?(?:rotate|translate|scale)-/.test(match[2]!)) add(match.index + 1 + plain.index, plain[0])
  }
  for (const match of source.matchAll(/(?<![\w-])(?:[\w\-[\]&=>.*()@/]+:)*animate-(\[[^\]\s]+\]|\([^)\s]+\)|[a-z][\w-]*)/g)) {
    const name = match[1]!
    if (name === "none" || name === "spin" || name === "pulse") continue
    if (name.startsWith("[") && !animationMoves(name.slice(1, -1), keyframes)) continue
    add(match.index, match[0])
  }
  for (const match of source.matchAll(/(?<![\w-])(?:[\w\-[\]&=>.*()@/]+:)*(?:active|hover|group-hover|group-active|peer-hover|peer-active)(?::[\w\-[\]&=>.*()@/]+)*:-?scale-[\w[\].]+/g)) {
    add(match.index, match[0])
  }
  // A CSS press or hover that moves, such as `button:active { transform: scale(.97) }`.
  for (const match of source.matchAll(/:(?:active|hover)\b[^{};]*\{[^}]*?(?<![\w-])(?:transform|scale|translate|rotate)\s*:(?!\s*none\b)[^;}]+/g)) {
    add(match.index, match[0])
  }
  for (const match of source.matchAll(/<(?:Transition|TransitionGroup|transition|transition-group)\b([^>]*)>/g)) {
    if (/(?<![\w-])-?(?:translate|scale|rotate)-|transition-(?:transform|all)\b|move-class/.test(match[1]!)) add(match.index, match[0])
  }
  for (const match of source.matchAll(/\.animate\(/g)) {
    if (/\b(?:transform|translate|scale|rotate|width|height|clipPath|clip-path|inset|left|top)\b/.test(balanced(source, match.index + match[0].length - 1))) add(match.index, match[0])
  }
  const writesStyle = /\.style\.\w+\s*=|\.style\.setProperty\(|\.setAttribute\(\s*["'`](?:transform|d|style|width|height|x|y|cx|cy|r)["'`]/.test(source)
  for (const match of source.matchAll(/requestAnimationFrame\(\s*(\w+)\s*\)/g)) {
    if (writesStyle && selfScheduling(source, match[1]!)) add(match.index, match[0])
  }
  return findings.sort((a, b) => a.line - b.line)
}

function scanMotionSurfaces(): Finding[] {
  const files = new Set<string>()
  for (const surface of motionSurfaces) {
    const root = join(repoRoot, surface)
    for (const file of surface.endsWith(".css") ? [root] : walkFiles(root, { ignoreDirs }).filter(file => sourceFile.test(file))) {
      const path = relative(repoRoot, file)
      if (!path.endsWith(".test.ts") && ![...motionExempt, ...ownMotionFigures.map(figure => figure.path)].some(prefix => path.startsWith(prefix))) files.add(path)
    }
  }
  const texts: Array<[string, string]> = [...files].sort().map(path => [path, readFileSync(join(repoRoot, path), "utf8")])
  const keyframes = collectKeyframes(texts)
  return texts.flatMap(([path, text]) => scanMotion(path, text, keyframes))
}

function withoutComments(file: string, text: string): string {
  if (!file.endsWith(".ts")) return text
  const source = createSourceFile(file, text, ScriptTarget.Latest)
  const ranges = new Map<number, number>()
  function visit(node: Node) {
    for (const range of [...getLeadingCommentRanges(text, node.pos) ?? [], ...getTrailingCommentRanges(text, node.end) ?? []]) {
      ranges.set(range.pos, range.end)
    }
    for (const child of node.getChildren(source)) visit(child)
  }
  visit(source)
  // Keep offsets and newlines so findings still point to the original source.
  let result = text
  for (const [start, end] of ranges) {
    result = result.slice(0, start) + text.slice(start, end).replace(/[^\r\n]/g, " ") + result.slice(end)
  }
  return result
}

function scanSource(file: string, text: string): Finding[] {
  const findings: Finding[] = []
  const source = withoutComments(file, text)
  // CSS rules can span lines, so the focus css rule reads the whole file and reports the line where the rule starts.
  for (const { rule, pattern } of rules) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`)
    for (const match of source.matchAll(global)) {
      const line = source.slice(0, match.index).split("\n").length
      findings.push({ file, line, rule, text: match[0].trim().slice(0, 80) })
    }
  }
  return findings
}

function scan(): Finding[] {
  const findings: Finding[] = []
  for (const surface of surfaces) {
    const root = join(repoRoot, surface)
    const files = surface.endsWith(".css") ? [root] : walkFiles(root, { ignoreDirs }).filter(file => sourceFile.test(file))
    for (const file of files) {
      const path = relative(repoRoot, file)
      if (allowed.some(prefix => path.startsWith(prefix)) || /\.test\.ts$/.test(path)) continue
      const fileFindings = scanSource(path, readFileSync(file, "utf8"))
      findings.push(...(focusThemes.some(prefix => path.startsWith(prefix)) ? fileFindings.filter(finding => !finding.rule.startsWith("focus")) : fileFindings))
    }
  }
  return findings
}

describe("design rules", () => {
  const findings = scan()

  for (const { rule } of rules) {
    it(`no ${rule} outside the theme`, () => {
      const found = findings.filter(finding => finding.rule === rule).map(finding => `${finding.file}:${finding.line} ${finding.text}`)
      expect(found, `${found.length} × ${rule}. See docs/DESIGN.md.\n${found.join("\n")}`).toEqual([])
    })
  }

  describe("hand-written motion", () => {
    const motion = scanMotionSurfaces()
    const byFile = new Map<string, Finding[]>()
    for (const finding of motion) byFile.set(finding.file, [...byFile.get(finding.file) ?? [], finding])

    it("has no hand-written motion outside the motion layer and the allowlist", () => {
      const found = [...byFile].filter(([file]) => !motionAllowlist[file]).flatMap(([, list]) => list).map(finding => `${finding.file}:${finding.line} ${finding.text}`)
      expect(found, `${found.length} × hand-written motion. Use the motion layer of @vite-hub/ui/motion or a motion helper. See docs/design/motion.md.\n${found.join("\n")}`).toEqual([])
    })

    it("lists only own-motion figures that exist, each with its reason", () => {
      const wrong = ownMotionFigures.filter(figure => !existsSync(join(repoRoot, figure.path)) || !figure.reason.trim()).map(figure => figure.path)
      expect(wrong, `Remove or explain these own-motion figures:\n${wrong.join("\n")}`).toEqual([])
    })

    it("keeps each allowlisted file at its count", () => {
      const wrong = Object.entries(motionAllowlist).flatMap(([file, { count }]) => {
        const list = byFile.get(file) ?? []
        if (list.length > count) return [`${file}: ${list.length} spots, the allowlist has ${count}. Do not add motion by hand.\n${list.map(finding => `  ${finding.line} ${finding.text}`).join("\n")}`]
        if (list.length < count) return [`${file}: ${list.length} spots, the allowlist has ${count}. Lower the count${list.length ? "" : " or remove the file"}.`]
        return []
      })
      expect(wrong, wrong.join("\n")).toEqual([])
    })

    const keyframes = collectKeyframes([["fixture.css", "@keyframes fade { from { opacity: 0 } } @keyframes rise { from { transform: translateY(4px) } } @keyframes turn { to { transform: rotate(1turn) } }"]])
    const lines = (file: string, text: string) => scanMotion(file, text, keyframes).map(finding => finding.line)

    it("finds CSS motion and leaves fades, colors, and spinners", () => {
      expect(lines("example.css", [
        "@keyframes rise { from { transform: translateY(4px) } }",
        "@keyframes fade { from { opacity: 0 } }",
        "@keyframes turn { to { transform: rotate(1turn) } }",
        ".a { animation: rise 200ms ease-out }",
        ".b { animation: fade 200ms ease-out; transition: opacity 150ms, color 150ms }",
        ".c { animation: turn 700ms linear infinite; transition: background-color 150ms ease-out }",
        ".d { transition: transform 150ms cubic-bezier(.2, .8, .2, 1) }",
        ".e { transition: 200ms }",
        ".f { transition-property: max-height }",
        "/* .g { transition: all 1s } */",
        ".h { transition: none; animation: none }",
        "button:active { transform: scale(.97) }",
        "button:hover { background: red; transform: none }",
        "button:active { scale:none }",
      ].join("\n"))).toEqual([1, 4, 7, 8, 9, 12])
    })

    it("finds Tailwind, Vue, WAAPI, and frame loop motion", () => {
      expect(lines("example.vue", [
        "<div class=\"transition-transform hover:bg-elevated\" />",
        "<div class=\"transition-colors animate-spin animate-pulse animate-none\" />",
        "<div class=\"motion-safe:active:scale-[.97] transition-[color,opacity]\" />",
        "<div class=\"animate-ping transition-[width]\" />",
        "<Transition enter-from-class=\"opacity-0 translate-y-1\">",
        "<Transition enter-from-class=\"opacity-0\">",
        "<!-- <div class=\"transition-all\" /> -->",
      ].join("\n"))).toEqual([1, 3, 4, 4, 5])
      expect(lines("example.ts", [
        "row.animate([{ backgroundColor: 'red' }, { backgroundColor: 'transparent' }], { duration: 300 })",
        "tab.animate([{ translate: '4px 0' }, { translate: '0 0' }], { duration: 220 })",
        "function loop() { box.style.width = `${width}px`; requestAnimationFrame(loop) }",
        "requestAnimationFrame(() => input.focus())",
        "// box.style.transition = 'transform 1s'",
      ].join("\n"))).toEqual([2, 3])
    })

    it("finds declarations that span lines and leaves fades that span lines", () => {
      expect(lines("example.vue", [
        "<template>",
        "  <UIcon class=\"size-3.5 transition group-open:rotate-90\" />",
        "  <div class=\"transition hover:text-highlighted\" :style=\"{ transition: 'opacity 1s' }\" />",
        "  <div :class=\"['transition-colors', open && 'rotate-180']\" />",
        "</template>",
        "<style scoped>",
        ".swap-enter-active {",
        "  transition:",
        "    opacity 180ms cubic-bezier(0.23, 1, 0.32, 1),",
        "    transform 180ms cubic-bezier(0.23, 1, 0.32, 1);",
        "}",
        ".fade {",
        "  transition:",
        "    opacity 180ms ease-out,",
        "    background-color 180ms ease-out;",
        "}",
        ".list { transition-property: opacity,",
        "  left }",
        ".pop {",
        "  animation:",
        "    rise 200ms ease-out;",
        "}",
        "</style>",
      ].join("\n"))).toEqual([2, 8, 17, 20])
      expect(lines("example.ts", [
        "const css = `.a {",
        "  transition:",
        "    color 150ms,",
        "    translate 150ms;",
        "}`",
        "Object.assign(panel.style, {",
        "  transition: `opacity 150ms,",
        "    scale 150ms`,",
        "  transitionProperty: fade,",
        "  color: 'red',",
        "})",
        "panel.style.setProperty('transition', 'width 200ms')",
        "panel.style.setProperty('transition', 'opacity 200ms')",
        "panel.style.transition = speed",
        "panel.style.width = '1px'",
      ].join("\n"))).toEqual([2, 7, 12])
    })
  })

  it("ignores issue references in TypeScript comments", () => {
    expect(scanSource("example.ts", [
      "// `#123` links to an issue.",
      "const value = 1 // See #abc.",
      "/* A comment with #123. */",
      "function empty() { /* #abc */ }",
    ].join("\n"))).toEqual([])
  })

  it("reports color literals in TypeScript strings at their original lines", () => {
    expect(scanSource("example.ts", [
      "/* #123",
      " * #abc */",
      "const color = '#123' // #abc",
      "const url = 'https://example.com/?color=#abc'",
      "const template = `prefix ${color} #def`",
    ].join("\n"))).toEqual([
      { file: "example.ts", line: 3, rule: "color literal", text: "#123" },
      { file: "example.ts", line: 4, rule: "color literal", text: "#abc" },
      { file: "example.ts", line: 5, rule: "color literal", text: "#def" },
    ])
  })
})

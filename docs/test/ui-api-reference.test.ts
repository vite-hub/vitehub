import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import * as headless from "@vite-hub/ui/headless";
import * as ui from "@vite-hub/ui";
import { describe, expect, it } from "vitest";

// Compare the hand-written API tables with the runtime component options, so the docs cannot drift.
const uiDocsRoot = resolve(import.meta.dirname, "../content/docs/ui");

interface RuntimePropOptions {
  default?: unknown;
  required?: boolean;
  type?: unknown;
}

interface RuntimeComponent {
  emits?: readonly string[] | Record<string, unknown>;
  name: string;
  props?: Record<string, RuntimePropOptions | unknown>;
  setup?: unknown;
}

function isRuntimeComponent(value: unknown): value is RuntimeComponent {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  const candidate: { name?: unknown; setup?: unknown } = value;
  return typeof candidate.name === "string" && typeof candidate.setup === "function";
}

const components = new Map<string, RuntimeComponent>();
for (const [exportName, value] of Object.entries({ ...ui, ...headless })) {
  if (isRuntimeComponent(value) && value.name === exportName) components.set(exportName, value);
}

function markdownFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

interface DocumentedTable {
  rows: { cells: string[]; name: string }[];
}

interface DocumentedComponent {
  events?: DocumentedTable;
  page: string;
  props?: DocumentedTable;
}

function parseTable(lines: string[]): DocumentedTable {
  const rows = lines.slice(2).map((line) => {
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim());
    return { cells, name: cells[0]!.replace(/^`|`$/g, "") };
  });
  return { rows };
}

function documentedComponents(): Map<string, DocumentedComponent> {
  const documented = new Map<string, DocumentedComponent>();
  for (const file of markdownFiles(uiDocsRoot)) {
    const page = relative(uiDocsRoot, file);
    const source = readFileSync(file, "utf8");
    const reference = source.split("\n## API reference\n")[1]?.split(/\n## (?!#)/)[0];
    if (!reference) continue;
    for (const section of reference.split(/\n### /).slice(1)) {
      const [heading = "", ...body] = section.split("\n");
      const name = heading.trim();
      if (!components.has(name)) continue;
      expect(documented.has(name), `${name} is documented twice`).toBe(false);
      const entry: DocumentedComponent = { page };
      const lines = body;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        const kind = /^\| (Prop|Event)\s+\|/.exec(line)?.[1];
        if (!kind) continue;
        const table: string[] = [];
        while (lines[index]?.startsWith("|")) table.push(lines[index++]!);
        if (kind === "Prop") entry.props = parseTable(table);
        else entry.events = parseTable(table);
      }
      documented.set(name, entry);
    }
  }
  return documented;
}

function runtimeDefault(options: RuntimePropOptions): string | undefined {
  if (options.required) return "Required";
  let value = options.default;
  if (typeof value === "function" && options.type !== Function) value = Reflect.apply(value, undefined, []);
  if (value === undefined) return options.type === Boolean ? "false" : undefined;
  if (typeof value === "string") return `'${value}'`;
  return JSON.stringify(value);
}

const documented = documentedComponents();

describe("UI API reference", () => {
  it("finds the public components at runtime", () => {
    expect(components.size).toBeGreaterThanOrEqual(24);
  });

  it("documents every public component on a UI page", () => {
    const missing = [...components.keys()].filter((name) => !documented.has(name));
    expect(missing).toEqual([]);
  });

  for (const [name, component] of components) {
    it(`matches the ${name} props and events`, () => {
      const entry = documented.get(name);
      if (!entry) return;
      const props = Object.entries(component.props ?? {});
      const documentedProps = entry.props?.rows ?? [];
      expect(documentedProps.map((row) => row.name).sort(), `${entry.page} ${name} props`).toEqual(
        props.map(([prop]) => prop).sort(),
      );
      for (const [prop, rawOptions] of props) {
        const options: RuntimePropOptions =
          rawOptions !== null && typeof rawOptions === "object" && !Array.isArray(rawOptions)
            ? rawOptions
            : { type: rawOptions };
        const row = documentedProps.find((candidate) => candidate.name === prop);
        const defaultCell = (row?.cells[2] ?? "").replace(/^`|`$/g, "");
        expect(defaultCell, `${entry.page} ${name}.${prop} default`).toBe(runtimeDefault(options) ?? "");
      }

      const emits = Array.isArray(component.emits) ? component.emits : Object.keys(component.emits ?? {});
      expect(
        (entry.events?.rows ?? []).map((row) => row.name).sort(),
        `${entry.page} ${name} events`,
      ).toEqual([...emits].sort());
    });
  }
});

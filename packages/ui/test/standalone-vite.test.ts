import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { standaloneUI } from "../src/standalone/vite.ts";

const stylesheet = resolve(import.meta.dirname, "../styles.css");

type Transform = { handler(code: string, id: string): unknown };

function transform(id: string): string {
  const hook = standaloneUI().transform as Transform;
  const result = hook.handler(readFileSync(stylesheet, "utf8"), id);
  if (typeof result !== "string") throw new TypeError(`The stylesheet was not transformed for ${id}.`);
  return result;
}

describe("standaloneUI()", () => {
  it.each(["", "?inline"])("drops the Chat and terminal styles from the stylesheet imported as %j", (query) => {
    const css = transform(`${stylesheet}${query}`);
    expect(css).not.toContain("comark-chat/style.css");
    expect(css).not.toContain("@xterm/xterm/css/xterm.css");
    expect(css).toContain("[data-slot=\"comment-layer\"]");
  });
});

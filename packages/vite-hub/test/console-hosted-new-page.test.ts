import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { consoleNewProjectPage } from "../src/console/hosted/new-project-page";

const index = readFileSync(new URL("../src/console/hosted/index.html", import.meta.url), "utf8");

describe("the /new page of the hosted Console", () => {
  it("does not draw the sidebar that index.html shows while a project opens", () => {
    expect(index).toContain("vh-primitive-rail");
    const page = consoleNewProjectPage(index);
    expect(page).not.toContain("vh-primitive-rail");
    expect(page).not.toContain("Opening Console");
    expect(page).toContain('<div id="app"><noscript class="vitehub-console-opening">Enable JavaScript to use the Console.</noscript></div>');
    expect(page.replace(/<div id="app">.*<\/div>$/m, "")).toBe(index.replace(/<div id="app">.*<\/div>$/m, ""));
  });

  it("fails the build when index.html changes shape", () => {
    expect(() => consoleNewProjectPage("<div id=\"app\"></div>")).toThrow(/noscript/);
  });
});

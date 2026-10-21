import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../../src/console/runtime/components/invocation/invocation.css"), "utf8");
const compactInvocationRules = `  .vh-invocation-thread__content {
    padding: 1.5rem 1rem 3rem;
  }

  .vh-invocation-message[data-role="user"] {
    margin-inline-start: 1rem;
  }`;

describe("Console invocation styles", () => {
  it("ships compact invocation styles for narrow sessions and viewports", () => {
    expect(stylesheet).toMatch(/\.vh-invocation-session\s*\{[^}]*container-type: inline-size;/);
    expect(stylesheet).toContain(`@container (max-width: 600px) {\n${compactInvocationRules}\n}`);
    expect(stylesheet).toContain(`@media (max-width: 600px) {\n${compactInvocationRules}\n}`);
  });

  it("ships flat surfaces that fill their containers", () => {
    for (const block of [".vh-invocation-session", ".vh-invocation-inspector", ".vh-invocation-list", ".vh-capability-inspector"]) {
      expect(stylesheet, block).toMatch(new RegExp(`\\n${block.replace(".", "\\.")}\\s*\\{[^}]*height: 100%;[^}]*min-height: 0;`));
    }
    expect(stylesheet).not.toMatch(/backdrop-filter|mask-image|linear-gradient/);
  });
});

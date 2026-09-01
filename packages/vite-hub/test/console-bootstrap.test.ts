import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

const consolePage = readFileSync(
  new URL("../src/console/runtime/components/console-app.vue", import.meta.url),
  "utf8",
);

it("releases bare Agents bootstrap when the newest invocation is unnamed", () => {
  expect(consolePage).toMatch(
    /if \(!firstInvocation\.agentName\) \{\s+initialBootstrapPending\.value = false;\s+return;\s+\}/,
  );
});

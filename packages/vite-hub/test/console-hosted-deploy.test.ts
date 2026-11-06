import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// console.vitehub.dev keeps project tokens in localStorage. These files decide which scripts run on its origin.
const headers = readFileSync(new URL("../src/console/hosted/public/_headers", import.meta.url), "utf8");
const wrangler: unknown = JSON.parse(readFileSync(new URL("../console.hosted.wrangler.jsonc", import.meta.url), "utf8")
  .split("\n").filter(line => !line.trim().startsWith("//")).join("\n"));

/** Headers of one `_headers` rule, such as `/*`. */
function rule(path: string): Map<string, string> {
  const lines = headers.split("\n");
  const start = lines.indexOf(path);
  expect(start, `_headers has a ${path} rule`).toBeGreaterThanOrEqual(0);
  const values = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    // `! Name` removes a header that an earlier rule set.
    if (/^\s+! /.test(line)) continue;
    const match = /^\s+([\w-]+):\s*(.+)$/.exec(line);
    if (!match) break;
    values.set(match[1]!.toLowerCase(), match[2]!);
  }
  return values;
}

function directives(policy: string): Map<string, string[]> {
  return new Map(policy.split(";").map(part => part.trim().split(/\s+/)).map(([name, ...sources]) => [name!, sources]));
}

describe("hosted Console deploy", () => {
  it("runs only the Console's own scripts and cannot be framed", () => {
    const page = rule("/*");
    const csp = directives(page.get("content-security-policy") ?? "");

    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("script-src")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    // A project can be any https origin, or a development server on this machine.
    expect(csp.get("connect-src")).toEqual(["'self'", "https:", "http://localhost:*", "http://127.0.0.1:*"]);
    expect(page.get("referrer-policy")).toBe("no-referrer");
    expect(page.get("x-content-type-options")).toBe("nosniff");
    expect(page.get("cache-control")).toBe("no-cache");
  });

  it("caches the hashed assets for a year", () => {
    expect(rule("/assets/*").get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("deploys the hosted build as static assets on the custom domain only", () => {
    expect(wrangler).toMatchObject({
      name: "vitehub-console",
      assets: { directory: ".vitehub/console-hosted", not_found_handling: "single-page-application" },
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: "console.vitehub.dev", custom_domain: true }],
    });
    expect(wrangler).not.toHaveProperty("main");
  });
});

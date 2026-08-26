import { describe, expect, it, vi } from "vitest";
import { checkExampleLinks, fetchWithRetry } from "../scripts/example-links.mjs";

describe("public example link checks", () => {
  it("classifies actions, default branches, and template start paths", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => new Response(
      String(input).startsWith("https://api.github.com/repos/") && !String(input).includes("/contents/")
        ? JSON.stringify({ default_branch: "main" })
        : "ok",
      { status: 200 },
    ));
    const result = await checkExampleLinks([
      { name: "Project", kind: "project", status: "published", action: { to: "https://github.com/vite-hub/project" } },
      { name: "Template", kind: "template", status: "published", action: { to: "https://github.com/vite-hub/template/generate" }, startPath: "app/index.ts" },
      { name: "Pending", kind: "project", status: "pending", action: {} },
    ], { attempts: 1, fetchImpl });

    expect(result.failures).toEqual([]);
    expect(result.checks.map(({ category }) => category)).toEqual([
      "catalog-url",
      "default-branch",
      "template-action",
      "default-branch",
      "start-path",
    ]);
    expect(result.checks.at(-1)?.url).toBe("https://api.github.com/repos/vite-hub/template/contents/app/index.ts?ref=main");
  });

  it("reports repositories without a default branch", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => new Response(
      String(input).startsWith("https://api.github.com/") ? "{}" : "ok",
      { status: 200 },
    ));
    const result = await checkExampleLinks([
      { name: "Project", kind: "project", status: "published", action: { to: "https://github.com/vite-hub/project" } },
    ], { attempts: 1, fetchImpl });

    expect(result.failures).toEqual([
      expect.objectContaining({ category: "default-branch", message: "response has no default_branch" }),
    ]);
  });

  it("times out, retries, and reports the final request error", async () => {
    const fetchImpl = vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));

    await expect(fetchWithRetry("https://example.test", {
      attempts: 2,
      fetchImpl,
      timeoutMs: 5,
    })).rejects.toThrow("https://example.test");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

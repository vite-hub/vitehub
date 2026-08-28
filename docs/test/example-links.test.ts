import { describe, expect, it, vi } from "vitest";
import { checkExampleLinks, fetchWithRetry } from "../scripts/example-links.mjs";

describe("public example link checks", () => {
  it("classifies actions, default branches, and template start paths", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => new Response(
      String(input).startsWith("https://api.github.com/repos/") && !String(input).includes("/contents/")
        ? JSON.stringify({ default_branch: "main", is_template: String(input).includes("/template") })
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

  it("checks the repository reached through a redirected GitHub action", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (String(input) === "https://www.github.com/vite-hub/template/generate") {
        const response = new Response("ok", { status: 200 });
        Object.defineProperty(response, "url", { value: "https://github.com/vite-hub/template/generate" });
        return response;
      }
      return new Response(JSON.stringify({ default_branch: "main", is_template: true }), { status: 200 });
    });
    const result = await checkExampleLinks([
      { name: "Template", kind: "template", status: "published", action: { to: "https://www.github.com/vite-hub/template/generate" }, startPath: "app/index.ts" },
    ], { attempts: 1, fetchImpl });

    expect(result.failures).toEqual([]);
    expect(result.checks.map(({ category }) => category)).toEqual([
      "template-action",
      "default-branch",
      "start-path",
    ]);
  });

  it("falls back to the original repository when a redirect is not repository-shaped", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (String(input) === "https://github.com/vite-hub/template/generate") {
        const response = new Response("ok", { status: 200 });
        Object.defineProperty(response, "url", { value: "https://github.com/new" });
        return response;
      }
      return new Response(JSON.stringify({ default_branch: "main", is_template: true }), { status: 200 });
    });
    const result = await checkExampleLinks([
      { name: "Template", kind: "template", status: "published", action: { to: "https://github.com/vite-hub/template/generate" }, startPath: "app/index.ts" },
    ], { attempts: 1, fetchImpl });

    expect(result.failures).toEqual([]);
    expect(result.checks.map(({ category }) => category)).toEqual([
      "template-action",
      "default-branch",
      "start-path",
    ]);
    expect(result.checks[1]?.url).toBe("https://api.github.com/repos/vite-hub/template");
  });

  it("rejects published templates whose repository has template mode disabled", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => new Response(
      String(input).startsWith("https://api.github.com/repos/") && !String(input).includes("/contents/")
        ? JSON.stringify({ default_branch: "main", is_template: false })
        : "ok",
      { status: 200 },
    ));
    const result = await checkExampleLinks([
      { name: "Template", kind: "template", status: "published", action: { to: "https://github.com/vite-hub/template/generate" }, startPath: "app/index.ts" },
    ], { attempts: 1, fetchImpl });

    expect(result.failures).toEqual([
      expect.objectContaining({ category: "template-action", message: "repository is not configured as a GitHub template" }),
    ]);
    expect(result.checks.map(({ category }) => category)).toEqual([
      "template-action",
      "default-branch",
    ]);
  });

  it("continues auditing after a malformed catalog URL", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const result = await checkExampleLinks([
      { name: "Malformed", kind: "project", status: "published", action: { to: "not a URL" } },
      { name: "Later", kind: "project", status: "published", action: { to: "https://example.com/later" } },
    ], { attempts: 1, fetchImpl });

    expect(result.failures).toEqual([
      expect.objectContaining({ category: "catalog-url", name: "Malformed" }),
    ]);
    expect(result.checks).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

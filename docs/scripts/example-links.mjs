import { object, safeParse, string } from "valibot";

const defaultTimeoutMs = 8_000;
const defaultAttempts = 3;
const repositoryMetadataSchema = object({ default_branch: string() });

function githubRepository(actionUrl) {
  const url = new URL(actionUrl);
  if (url.hostname !== "github.com") return undefined;
  const [owner, repository] = url.pathname.split("/").filter(Boolean);
  return owner && repository ? { owner, repository } : undefined;
}

export async function fetchWithRetry(url, {
  attempts = defaultAttempts,
  fetchImpl = fetch,
  headers,
  timeoutMs = defaultTimeoutMs,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${url}: ${lastError?.message ?? "request failed"}`);
}

export async function checkExampleLinks(examples, options = {}) {
  const failures = [];
  const checks = [];
  const request = (url) => {
    const isGitHubApi = new URL(url).hostname === "api.github.com";
    const headers = { "User-Agent": "vitehub-docs-link-check" };
    if (isGitHubApi) headers.Accept = "application/vnd.github+json";
    if (isGitHubApi && options.token) headers.Authorization = `Bearer ${options.token}`;
    return fetchWithRetry(url, { ...options, headers });
  };

  async function check(category, name, url) {
    checks.push({ category, name, url });
    try {
      return await request(url);
    } catch (error) {
      failures.push({ category, name, url, message: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  for (const example of examples) {
    if (example.status !== "published") continue;
    const category = example.kind === "template" ? "template-action" : "catalog-url";
    await check(category, example.name, example.action.to);

    const repository = githubRepository(example.action.to);
    if (!repository) continue;
    const apiRoot = `https://api.github.com/repos/${repository.owner}/${repository.repository}`;
    const metadata = await check("default-branch", example.name, apiRoot);
    if (!metadata) continue;
    try {
      const metadataResult = safeParse(repositoryMetadataSchema, await metadata.json());
      if (!metadataResult.success || !metadataResult.output.default_branch) {
        failures.push({ category: "default-branch", name: example.name, url: apiRoot, message: "response has no default_branch" });
        continue;
      }
      if (example.kind !== "template") continue;
      const startPath = example.startPath.split("/").map(encodeURIComponent).join("/");
      await check("start-path", example.name, `${apiRoot}/contents/${startPath}?ref=${encodeURIComponent(metadataResult.output.default_branch)}`);
    } catch (error) {
      failures.push({ category: "default-branch", name: example.name, url: apiRoot, message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  return { checks, failures };
}

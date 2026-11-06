#!/usr/bin/env node
// Deletes the Cloudflare resources that one live-smoke run created.
// It deletes only names equal to the run prefix or that start with "<prefix>-".
// A resource that does not exist is not an error.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const apiBase = "https://api.cloudflare.com/client/v4";
const prefixPattern = /^vitehub-smoke-\d+$/;
const perPage = 100;
const maxPages = 50;

export function assertScratchPrefix(prefix) {
  if (typeof prefix !== "string" || !prefixPattern.test(prefix)) {
    throw new Error(`Refusing to tear down ${JSON.stringify(prefix)}: the prefix must match ${prefixPattern}.`);
  }
}

export function isScratchName(name, prefix) {
  return typeof name === "string" && (name === prefix || name.startsWith(`${prefix}-`));
}

function createCloudflareClient({ accountId, apiToken, fetch }) {
  return async function request(path, { method = "GET", query } = {}) {
    const url = new URL(`${apiBase}/accounts/${encodeURIComponent(accountId)}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    const response = await fetch(url, { method, headers: { authorization: `Bearer ${apiToken}` } });
    const body = await response.json().catch(() => undefined);
    return { status: response.status, ok: response.ok && body?.success !== false, body };
  };
}

function describeFailure(response) {
  const errors = Array.isArray(response.body?.errors)
    ? response.body.errors.map(error => `${error.code ?? "?"} ${error.message ?? ""}`.trim()).join("; ")
    : "";
  return `HTTP ${response.status}${errors ? ` (${errors})` : ""}`;
}

function readList(body, key) {
  const result = Array.isArray(body) ? body : body?.result;
  if (Array.isArray(result)) return result;
  if (key && Array.isArray(result?.[key])) return result[key];
  return undefined;
}

async function listAll(request, path, { key, query = {} } = {}) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const response = await request(path, { query: { ...query, page, per_page: perPage } });
    if (!response.ok) throw new Error(`GET ${path} failed: ${describeFailure(response)}`);
    const listed = readList(response.body, key);
    if (!listed) throw new Error(`GET ${path} returned an invalid list.`);
    items.push(...listed);
    const totalPages = response.body?.result_info?.total_pages;
    if (typeof totalPages === "number" ? page >= totalPages : listed.length < perPage) return items;
  }
  throw new Error(`GET ${path} returned more than ${maxPages} pages.`);
}

async function listContainerApplications(request) {
  const path = "/containers/applications";
  const applications = [];
  let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const response = await request(path, { query: pageToken ? { page_token: pageToken } : {} });
    if (!response.ok) throw new Error(`GET ${path} failed: ${describeFailure(response)}`);
    const listed = readList(response.body);
    if (!listed) throw new Error(`GET ${path} returned an invalid list.`);
    applications.push(...listed);
    pageToken = response.body?.result_info?.next_page_token;
    if (!pageToken) return applications;
  }
  throw new Error(`GET ${path} returned more than ${maxPages} pages.`);
}

async function deleteOne(request, path, query) {
  const response = await request(path, { method: "DELETE", query });
  if (response.ok) return "deleted";
  if (response.status === 404) return "absent";
  throw new Error(`DELETE ${path} failed: ${describeFailure(response)}`);
}

async function emptyR2Bucket(request, bucket) {
  const path = `/r2/buckets/${encodeURIComponent(bucket)}/objects`;
  for (let page = 0; page < maxPages; page++) {
    const response = await request(path, { query: { per_page: 1000 } });
    if (!response.ok) throw new Error(`GET ${path} failed: ${describeFailure(response)}`);
    const objects = readList(response.body, "objects");
    if (!objects) throw new Error(`GET ${path} returned an invalid list.`);
    if (!objects.length) return;
    for (const object of objects) {
      // R2 requires literal separators while other characters stay percent-encoded.
      const key = object.key.split("/").map(segment => encodeURIComponent(segment)).join("/");
      await deleteOne(request, `${path}/${key}`);
    }
  }
  throw new Error(`R2 bucket ${bucket} still had objects after ${maxPages} passes.`);
}

function createWranglerImages(wrangler) {
  if (!wrangler || !existsSync(wrangler)) return undefined;
  return {
    list(prefix) {
      const output = execFileSync(wrangler, ["containers", "images", "list", "--filter", prefix, "--json"], { encoding: "utf8" });
      const parsed = JSON.parse(output.slice(output.indexOf("[")));
      if (!Array.isArray(parsed)) throw new Error("wrangler containers images list returned an invalid list.");
      return parsed;
    },
    delete(image) {
      execFileSync(wrangler, ["containers", "images", "delete", image, "--skip-confirmation"], { stdio: "inherit" });
    },
  };
}

/**
 * Deletes the scratch resources in dependency order. Each resource kind runs even when an
 * earlier kind fails, so one failure does not leave the rest behind.
 */
export async function teardownCloudflare({ accountId, apiToken, prefix, fetch = globalThis.fetch, images, log = console.log }) {
  assertScratchPrefix(prefix);
  const request = createCloudflareClient({ accountId, apiToken, fetch });
  const deleted = [];
  const failures = [];
  const record = (kind, name, result) => {
    if (result === "deleted") deleted.push(`${kind} ${name}`);
    log(`${result}\t${kind}\t${name}`);
  };

  async function step(kind, run) {
    try {
      await run();
    }
    catch (error) {
      failures.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await step("container application", async () => {
    for (const application of await listContainerApplications(request)) {
      if (!isScratchName(application?.name, prefix)) continue;
      record("container application", application.name, await deleteOne(request, `/containers/applications/${encodeURIComponent(application.id)}`));
    }
  });

  await step("worker", async () => {
    record("worker", prefix, await deleteOne(request, `/workers/scripts/${encodeURIComponent(prefix)}`, { force: "true" }));
  });

  await step("container image", async () => {
    if (!images) {
      log(`skipped\tcontainer image\twrangler is not installed`);
      return;
    }
    for (const repository of images.list(prefix)) {
      if (!isScratchName(repository?.name, prefix)) continue;
      for (const tag of repository.tags ?? []) {
        images.delete(`${repository.name}:${tag}`);
        record("container image", `${repository.name}:${tag}`, "deleted");
      }
    }
  });

  await step("workflow", async () => {
    for (const workflow of await listAll(request, "/workflows")) {
      if (!isScratchName(workflow?.name, prefix)) continue;
      record("workflow", workflow.name, await deleteOne(request, `/workflows/${encodeURIComponent(workflow.name)}`));
    }
  });

  await step("queue", async () => {
    for (const queue of await listAll(request, "/queues")) {
      if (!isScratchName(queue?.queue_name, prefix)) continue;
      record("queue", queue.queue_name, await deleteOne(request, `/queues/${encodeURIComponent(queue.queue_id)}`));
    }
  });

  await step("d1 database", async () => {
    for (const database of await listAll(request, "/d1/database", { query: { name: prefix } })) {
      if (!isScratchName(database?.name, prefix)) continue;
      record("d1 database", database.name, await deleteOne(request, `/d1/database/${encodeURIComponent(database.uuid)}`));
    }
  });

  await step("kv namespace", async () => {
    for (const namespace of await listAll(request, "/storage/kv/namespaces")) {
      if (!isScratchName(namespace?.title, prefix)) continue;
      record("kv namespace", namespace.title, await deleteOne(request, `/storage/kv/namespaces/${encodeURIComponent(namespace.id)}`));
    }
  });

  await step("r2 bucket", async () => {
    const response = await request("/r2/buckets", { query: { name_contains: prefix, per_page: 1000 } });
    if (!response.ok) throw new Error(`GET /r2/buckets failed: ${describeFailure(response)}`);
    const buckets = readList(response.body, "buckets");
    if (!buckets) throw new Error("GET /r2/buckets returned an invalid list.");
    for (const bucket of buckets) {
      if (!isScratchName(bucket?.name, prefix)) continue;
      const path = `/r2/buckets/${encodeURIComponent(bucket.name)}`;
      const first = await request(path, { method: "DELETE" });
      if (first.ok || first.status === 404) {
        record("r2 bucket", bucket.name, first.ok ? "deleted" : "absent");
        continue;
      }
      // R2 deletes only empty buckets. Delete the objects that a failed test left, then retry.
      await emptyR2Bucket(request, bucket.name);
      record("r2 bucket", bucket.name, await deleteOne(request, path));
    }
  });

  return { deleted, failures };
}

async function runFromCommandLine(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      prefix: { type: "string" },
      wrangler: { type: "string" },
    },
    strict: true,
  });
  assertScratchPrefix(values.prefix);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    // Without credentials no earlier step could create a resource.
    console.log("::warning::Skipping Cloudflare teardown: CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN is missing.");
    return 0;
  }
  const { deleted, failures } = await teardownCloudflare({
    accountId,
    apiToken,
    prefix: values.prefix,
    images: createWranglerImages(values.wrangler && resolve(values.wrangler)),
  });
  console.log(`Deleted ${deleted.length} Cloudflare resources with prefix ${values.prefix}.`);
  for (const failure of failures) console.log(`::error::Teardown left a resource: ${failure}`);
  return failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runFromCommandLine(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}

import type { FeatureId } from "@vite-hub/internal/features";

import type { HostConfigs } from "../utils/host-config";

// What `vitehub({...})` sets on each host, for the primitive heroes that opt in with `:::code-tree{feature="..."}`.
// The feature catalog decides which hosts support a feature. This map only holds the config text, and
// `docs/test/host-configs.test.ts` checks both against each other and against the landing pages.

const envImport = "import { env } from 'vite-hub/env'";

const libsqlConnection = `{
  connection: {
    url: env({
      source: env.source('TURSO_DATABASE_URL'),
    }),
    authToken: env({
      secret: true,
      source: env.source('TURSO_AUTH_TOKEN'),
    }),
  },
}`;

const resendDriver = `{
  driver: 'resend',
  // The server reads the key when it sends
  options: {
    apiKey: env({
      secret: true,
      source: env.source('RESEND_API_KEY'),
    }),
  },
}`;

const resend = {
  imports: [envImport],
  options: { email: { comment: "Resend sends the email", value: resendDriver } },
};

export const hostConfigs: Partial<Record<FeatureId, HostConfigs>> = {
  blob: {
    cloudflare: { options: { blob: { comment: "On Cloudflare, files are saved in R2", value: "true" } } },
    // blob/configure.md, "S3 and S3-compatible providers": `s3` requires `bucket`.
    deno: { options: { blob: { comment: "On Deno, files are saved in an S3 bucket", value: "{ driver: 's3', bucket: 'avatars' }" } } },
    netlify: { options: { blob: { comment: "On Netlify, files are saved in Netlify Blobs", value: "true" } } },
    node: { options: { blob: { comment: "On Node, files are saved in .vitehub/data/blob", value: "true" } } },
    vercel: { options: { blob: { comment: "On Vercel, files are saved in Vercel Blob", value: "true" } } },
  },
  // database/hosts.md, "Select a hosted database for Vercel": a libSQL `connection` read from Env.
  database: {
    cloudflare: { options: { database: { comment: "On Cloudflare, tables are saved in D1", value: "true" } } },
    deno: { imports: [envImport], options: { database: { comment: "On Deno, tables are saved in hosted libSQL", value: libsqlConnection } } },
    netlify: { imports: [envImport], options: { database: { comment: "On Netlify, tables are saved in hosted libSQL", value: libsqlConnection } } },
    node: { options: { database: { comment: "On Node, tables are saved in local SQLite", value: "true" } } },
    vercel: { imports: [envImport], options: { database: { comment: "On Vercel, tables are saved in hosted libSQL", value: libsqlConnection } } },
  },
  // email/configure.md, "Configure Vite": `email: true` selects Cloudflare Email. Other hosts set `driver: 'resend'`.
  email: {
    cloudflare: { options: { email: { comment: "Cloudflare Email sends the email", value: "true" } } },
    deno: resend,
    netlify: resend,
    node: resend,
    vercel: resend,
  },
  // kv/configure.md, "Configuration options": `kv: { driver: 'upstash' }` reads its URL and token from Env.
  kv: {
    cloudflare: { options: { kv: { comment: "On Cloudflare, use Workers KV", value: "true" } } },
    deno: { options: { kv: { comment: "On Deno, use Deno KV", value: "true" } } },
    netlify: { options: { kv: { comment: "On Netlify, use Upstash Redis", value: "{ driver: 'upstash' }" } } },
    node: { options: { kv: { comment: "Node supports shared stores and local files", value: "true" } } },
    vercel: { options: { kv: { comment: "On Vercel, use Upstash Redis", value: "true" } } },
  },
  queue: {
    cloudflare: { options: { queue: { comment: "On Cloudflare, jobs go to Cloudflare Queues", value: "true" } } },
    node: { options: { queue: { comment: "On Node, jobs run in the server process", value: "true" } } },
    vercel: { options: { queue: { comment: "On Vercel, jobs go to Vercel Queues", value: "true" } } },
  },
  rateLimit: {
    cloudflare: { options: { rateLimit: { comment: "On Cloudflare, a binding keeps counts", value: "true" } } },
    node: { options: { rateLimit: { comment: "On Node, counts stay in memory. Turn on KV to share them.", value: "true" } } },
  },
  // realtime/configure.md, "Choose a room authority": `memory` for one Node process, `auto` selects Durable Objects.
  realtime: {
    cloudflare: { options: { realtime: { comment: "Keep rooms in Durable Objects", value: "true" } } },
    node: { options: { realtime: { comment: "Keep rooms in this server process", value: "{ authority: 'memory' }" } } },
  },
  sandboxTask: {
    cloudflare: { options: { sandboxTask: { comment: "Each run starts a Cloudflare Sandbox", value: "true" } } },
    vercel: { options: { sandboxTask: { comment: "Each run starts a Vercel Sandbox", value: "true" } } },
  },
  // schedule/hosts.md, "Provider output": Node has no host cron, so a build needs `runtime: { driver: 'process' }`.
  // schedule/configure.md, "Storage": only the Process Runtime keeps its run history in KV. A host cron
  // starts each Schedule without a run record, so the other hosts do not need `kv`.
  schedule: {
    cloudflare: { options: { schedule: { comment: "Cron Triggers start each schedule", value: "true" } }, remove: ["kv"] },
    netlify: { options: { schedule: { comment: "A scheduled function starts each schedule", value: "true" } }, remove: ["kv"] },
    node: { options: { schedule: { comment: "Checks for due schedules every minute", value: "{ runtime: { driver: 'process' } }" } } },
    vercel: { options: { schedule: { comment: "Vercel Cron starts each schedule", value: "true" } }, remove: ["kv"] },
  },
};

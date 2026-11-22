import type { ExecutionAuthority } from "@vite-hub/runtime";

import { sandboxErrorDiagnostics } from "../error-diagnostics.ts";

/**
 * The outbound network of a Sandbox. The `vercel` and `cloudflare` runtimes take this form.
 * - `"allow-all"`: no limit. This is the default.
 * - `"deny-all"`: no network exit.
 * - `{ allow }`: HTTP and HTTPS only to these hostnames. `"*.example.com"` matches subdomains only.
 *   Other protocols have no exit.
 */
export type SandboxNetworkPolicy =
  | "allow-all"
  | "deny-all"
  | { allow: readonly string[] };

/** A validated policy. An empty allowlist is `"deny-all"`, and `"*"` is `"allow-all"`. Hostnames are lowercase, unique, and sorted. */
export type NormalizedSandboxNetworkPolicy = "allow-all" | "deny-all" | { allow: string[] };

const maxCloudflareAllowedHosts = 64;

const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const hostPattern = new RegExp(`^(?:\\*\\.)?(?:${label}\\.)+${label}$|^${label}$`);

/** Validates a policy for the `cloudflare` runtime, which takes only the portable form. */
export function normalizeCloudflareNetworkPolicy(value: unknown): NormalizedSandboxNetworkPolicy {
  if (value === undefined || value === "allow-all") return "allow-all";
  if (value === "deny-all") return "deny-all";
  const invalid = (problem: string) => sandboxErrorDiagnostics.SANDBOX_NETWORK_POLICY_INVALID({ problem });
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid(`networkPolicy must be "allow-all", "deny-all", or { allow: string[] }, not ${JSON.stringify(value)}.`);
  const extra = Object.keys(value).filter(key => key !== "allow");
  if (extra.length)
    throw invalid(`Cloudflare does not support networkPolicy.${extra[0]}. Only Vercel supports subnets.`);
  const allow = (value as { allow?: unknown }).allow;
  if (!Array.isArray(allow)) throw invalid("networkPolicy.allow must be an array of hostnames.");
  const hosts = new Set<string>();
  for (const entry of allow) {
    const host = typeof entry === "string" ? entry.trim().toLowerCase().replace(/\.$/, "") : undefined;
    if (host === "*") return "allow-all";
    if (host === undefined || !hostPattern.test(host))
      throw invalid(`networkPolicy.allow entry ${JSON.stringify(entry)} is not a hostname. Use a name such as "api.example.com" or "*.example.com". IP addresses are not supported.`);
    if (/^[\d.]+$/.test(host))
      throw invalid(`networkPolicy.allow entry ${JSON.stringify(entry)} is an IP address. Cloudflare filters HTTPS by hostname only.`);
    hosts.add(host);
  }
  if (hosts.size > maxCloudflareAllowedHosts)
    throw invalid(`networkPolicy.allow has ${hosts.size} hostnames. Cloudflare allows at most ${maxCloudflareAllowedHosts}. Use a pattern such as "*.example.com".`);
  if (hosts.size === 0) return "deny-all";
  return { allow: [...hosts].sort() };
}

/** The `network` fact of `executionAuthority` for a validated policy. */
export function sandboxNetworkAuthority(policy: NormalizedSandboxNetworkPolicy): ExecutionAuthority["network"] {
  if (policy === "allow-all") return "unrestricted";
  if (policy === "deny-all") return "none";
  return "restricted";
}

const cloudflareContainerCa = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

export const cloudflareInterceptedHttpsEnv: Readonly<Record<string, string>> = Object.freeze({
  CURL_CA_BUNDLE: cloudflareContainerCa,
  GIT_SSL_CAINFO: cloudflareContainerCa,
  NODE_EXTRA_CA_CERTS: cloudflareContainerCa,
  REQUESTS_CA_BUNDLE: cloudflareContainerCa,
  SSL_CERT_FILE: cloudflareContainerCa,
});

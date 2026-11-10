import { addCollection } from "@iconify/vue";

import type { FeatureId } from "@vite-hub/internal/features";
import type { NewProjectHost } from "./new-project";

/** The icon of each feature on `/new`: its ViteHub primitive icon, or Lucide where ViteHub has none. */
export const newProjectFeatureIcons: Readonly<Record<FeatureId, string>> = {
  agent: "i-vitehub-agent",
  auth: "i-vitehub-auth",
  blob: "i-vitehub-blob",
  browser: "i-vitehub-browser",
  cache: "i-lucide-database-zap",
  channels: "i-vitehub-channels",
  comments: "i-vitehub-comments",
  connections: "i-vitehub-connections",
  console: "i-vitehub-development",
  database: "i-vitehub-database",
  email: "i-vitehub-email",
  env: "i-vitehub-env",
  i18n: "i-lucide-languages",
  kv: "i-vitehub-kv",
  logs: "i-vitehub-logs",
  mcp: "i-lucide-plug",
  observability: "i-lucide-activity",
  queue: "i-vitehub-queue",
  rateLimit: "i-vitehub-rate-limit",
  realtime: "i-vitehub-realtime",
  sandboxTask: "i-vitehub-sandbox",
  schedule: "i-vitehub-schedule",
  workflow: "i-vitehub-workflow",
  workspace: "i-vitehub-workspace",
};

/** The logo of each host on `/new`. */
export const newProjectHostIcons: Readonly<Record<NewProjectHost, string>> = {
  cloudflare: "i-vitehub-host-cloudflare",
  vercel: "i-vitehub-host-vercel",
  netlify: "i-vitehub-host-netlify",
  deno: "i-vitehub-host-deno",
  node: "i-vitehub-host-node",
};

/**
 * Add the host logos to the `vitehub` icon set. They are one-color marks from Simple Icons (CC0 1.0), which follow the
 * text color. The Console CSP blocks the Iconify API, so the page ships them.
 */
export function addNewProjectHostIcons(): void {
  addCollection({
    prefix: "vitehub",
    width: 24,
    height: 24,
    icons: {
    "host-cloudflare": { body: "<path fill=\"currentColor\" d=\"M16.509 16.845c.147-.507.09-.971-.155-1.316c-.225-.316-.605-.499-1.062-.52l-8.66-.113a.16.16 0 0 1-.133-.07a.2.2 0 0 1-.02-.156a.24.24 0 0 1 .203-.156l8.736-.113c1.035-.049 2.16-.886 2.554-1.913l.499-1.302a.27.27 0 0 0 .014-.168a5.689 5.689 0 0 0-10.937-.584a2.58 2.58 0 0 0-1.794-.498a2.56 2.56 0 0 0-2.223 3.18A3.634 3.634 0 0 0 0 16.751q.002.264.035.527a.174.174 0 0 0 .17.148h15.98a.22.22 0 0 0 .204-.155zm2.757-5.564c-.077 0-.161 0-.239.011c-.056 0-.105.042-.127.098l-.337 1.174c-.148.507-.092.971.154 1.317c.225.316.605.498 1.062.52l1.844.113c.056 0 .105.026.133.07a.2.2 0 0 1 .021.156a.24.24 0 0 1-.204.156l-1.92.112c-1.042.049-2.159.887-2.553 1.914l-.141.358c-.028.072.021.142.099.142h6.597a.174.174 0 0 0 .17-.126a5 5 0 0 0 .175-1.28a4.74 4.74 0 0 0-4.734-4.727\"/>" },
    "host-vercel": { body: "<path fill=\"currentColor\" d=\"m12 1.608l12 20.784H0Z\"/>" },
    "host-netlify": { body: "<path fill=\"currentColor\" d=\"M6.49 19.04h-.23L5.13 17.9v-.23l1.73-1.71h1.2l.15.15v1.2L6.5 19.04ZM5.13 6.31V6.1l1.13-1.13h.23L8.2 6.68v1.2l-.15.15h-1.2zm9.96 9.09h-1.65l-.14-.13v-3.83c0-.68-.27-1.2-1.1-1.23c-.42 0-.9 0-1.43.02l-.07.08v4.96l-.14.14H8.9l-.13-.14V8.73l.13-.14h3.7a2.6 2.6 0 0 1 2.61 2.6v4.08l-.13.14Zm-8.37-2.44H.14L0 12.82v-1.64l.14-.14h6.58l.14.14v1.64zm17.14 0h-6.58l-.14-.14v-1.64l.14-.14h6.58l.14.14v1.64zM11.05 6.55V1.64l.14-.14h1.65l.14.14v4.9l-.14.14h-1.65zm0 15.81v-4.9l.14-.14h1.65l.14.13v4.91l-.14.14h-1.65z\"/>" },
    "host-deno": { body: "<path fill=\"currentColor\" d=\"M1.105 18.02A11.9 11.9 0 0 1 0 12.985q0-.698.078-1.376a12 12 0 0 1 .231-1.34A12 12 0 0 1 4.025 4.02a12 12 0 0 1 5.46-2.771a12 12 0 0 1 3.428-.23c1.452.112 2.825.477 4.077 1.05a12 12 0 0 1 2.78 1.774a12.02 12.02 0 0 1 4.053 7.078A12 12 0 0 1 24 12.985q0 .454-.036.914a12 12 0 0 1-.728 3.305a12 12 0 0 1-2.38 3.875c-1.33 1.357-3.02 1.962-4.43 1.936a4.4 4.4 0 0 1-2.724-1.024c-.99-.853-1.391-1.83-1.53-2.919a5 5 0 0 1 .128-1.518c.105-.38.37-1.116.76-1.437c-.455-.197-1.04-.624-1.226-.829c-.045-.05-.04-.13 0-.183a.155.155 0 0 1 .177-.053c.392.134.869.267 1.372.35c.66.111 1.484.25 2.317.292c2.03.1 4.153-.813 4.812-2.627s.403-3.609-1.96-4.685s-3.454-2.356-5.363-3.128c-1.247-.505-2.636-.205-4.06.582c-3.838 2.121-7.277 8.822-5.69 15.032a.191.191 0 0 1-.315.19a12 12 0 0 1-1.25-1.634a12 12 0 0 1-.769-1.404M11.57 6.087c.649-.051 1.214.501 1.31 1.236c.13.979-.228 1.99-1.41 2.013c-1.01.02-1.315-.997-1.248-1.614c.066-.616.574-1.575 1.35-1.635\"/>" },
    "host-node": { body: "<path fill=\"currentColor\" d=\"M11.998 24c-.321 0-.641-.084-.922-.247L8.14 22.016c-.438-.245-.224-.332-.08-.383c.585-.203.703-.25 1.328-.604c.065-.037.151-.023.218.017l2.256 1.339a.29.29 0 0 0 .272 0l8.795-5.076a.28.28 0 0 0 .134-.238V6.921a.28.28 0 0 0-.137-.242l-8.791-5.072a.28.28 0 0 0-.271 0L3.075 6.68a.28.28 0 0 0-.139.241v10.15a.27.27 0 0 0 .139.235l2.409 1.392c1.307.654 2.108-.116 2.108-.89V7.787c0-.142.114-.253.256-.253h1.115c.139 0 .255.112.255.253v10.021c0 1.745-.95 2.745-2.604 2.745c-.508 0-.909 0-2.026-.551L2.28 18.675a1.86 1.86 0 0 1-.922-1.604V6.921c0-.659.353-1.275.922-1.603L11.075.236a1.93 1.93 0 0 1 1.848 0l8.794 5.082c.57.329.924.944.924 1.603v10.15a1.86 1.86 0 0 1-.924 1.604l-8.794 5.078c-.28.163-.599.247-.925.247m7.101-10.007c0-1.9-1.284-2.406-3.987-2.763c-2.731-.361-3.009-.548-3.009-1.187c0-.528.235-1.233 2.258-1.233c1.807 0 2.473.389 2.747 1.607a.254.254 0 0 0 .247.199h1.141a.26.26 0 0 0 .186-.081a.26.26 0 0 0 .067-.196c-.177-2.098-1.571-3.076-4.388-3.076c-2.508 0-4.004 1.058-4.004 2.833c0 1.925 1.488 2.457 3.895 2.695c2.88.282 3.103.703 3.103 1.269c0 .983-.789 1.402-2.642 1.402c-2.327 0-2.839-.584-3.011-1.742a.255.255 0 0 0-.253-.215h-1.137a.25.25 0 0 0-.254.253c0 1.482.806 3.248 4.655 3.248c2.788.001 4.386-1.096 4.386-3.013\"/>" },
    },
  });
}

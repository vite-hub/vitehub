import type { SecretEnv } from "@vite-hub/env/secret";
import { usePublicEnv } from "#vitehub/env/public";
import { useServerEnv } from "#vitehub/env/server";

const publicEnv = usePublicEnv();
const serverEnv = useServerEnv();

const roles: Array<"read" | "write"> = serverEnv.roles;
const settings: { enabled: boolean; retries: number; tags: string[] } = serverEnv.settings;
const metadata: Record<string, unknown> | undefined = serverEnv.metadata;
const tags: string[] = publicEnv.tags;
// @ts-expect-error JSON enum array elements retain their union.
const wrongRole: "admin" = serverEnv.roles[0];
// @ts-expect-error JSON object property types are generated.
const wrongEnabled: string = serverEnv.settings.enabled;

const appName: string = publicEnv.appName;
const plan: "free" | "team" = publicEnv.plan;
const notice: string | undefined = publicEnv.notice;
const retries: number = serverEnv.retries;
const dryRun: boolean = serverEnv.dryRun;
const mode: "draft" | "send" = serverEnv.mode;
const endpoint: string = serverEnv.serviceUrl;
const timeout: number = serverEnv.timeout;
const label: string = serverEnv.label;
const token: SecretEnv<string> = serverEnv.apiToken;

// @ts-expect-error Server credentials are absent from Public Env.
const wrongPublicToken = publicEnv.apiToken;
// @ts-expect-error An enum keeps every allowed member after preparing types.
const wrongPlan: "enterprise" = publicEnv.plan;
// @ts-expect-error Converted runtime values are numbers.
const wrongRetries: string = serverEnv.retries;
// @ts-expect-error A secret wrapper cannot be passed as an ordinary string.
const wrongToken: string = serverEnv.apiToken;

void [
  roles,
  settings,
  metadata,
  tags,
  wrongRole,
  wrongEnabled,
  appName,
  plan,
  notice,
  retries,
  dryRun,
  mode,
  endpoint,
  timeout,
  label,
  token,
  wrongPlan,
  wrongRetries,
  wrongToken,
  wrongPublicToken,
];

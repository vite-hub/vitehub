import { setTimeout as sleep } from "node:timers/promises";
import { forgeErrorStatus } from "@vite-hub/forge";

const transientStatuses = new Set([502, 503, 504]);
const transientMessage = /fetch failed|socket hang up|socket disconnected|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR_/i;
const retryDelaysMs = [1000, 3000];

/**
 * A dropped connection, a request timeout, or a gateway error from GitHub or a provider. It says nothing
 * about the pull request, so the same request can succeed a moment later.
 */
export function isTransientNetworkError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++, current = current.cause) {
    if (current.name === "ForgeNetworkError" || current.name === "ForgeTimeoutError") return true;
    const status = forgeErrorStatus(current);
    if (status !== undefined && transientStatuses.has(status)) return true;
    const code = "code" in current ? String(current.code) : "";
    if (transientMessage.test(`${current.message} ${code}`)) return true;
  }
  return false;
}

/** Runs a read again after 1 and 3 seconds while it fails with a transient network error. */
export async function retryTransient<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const delay = retryDelaysMs[attempt];
      if (delay === undefined || signal?.aborted || !isTransientNetworkError(error)) throw error;
      await sleep(delay, undefined, { signal });
    }
  }
}

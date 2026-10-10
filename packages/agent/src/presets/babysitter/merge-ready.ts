import { hasRuntimeType } from "../../internal/runtime-type.ts";

/** Fence application callbacks so stalled or rejected readiness never retains a scheduler slot. */
export async function boundedMergeReady(ready: () => boolean | string | Promise<boolean | string>, signal?: AbortSignal, timeoutMs = 5000): Promise<true | string> {
  if (signal?.aborted) return "merge readiness cancelled";
  return new Promise(resolve => {
    const finish = (result: true | string) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => finish("merge readiness cancelled");
    const timer = setTimeout(() => finish("merge readiness timed out"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(ready).then(
      result => finish(result === true ? true : hasRuntimeType(result, "string") ? result : "merge readiness declined"),
      () => finish("merge readiness check failed"),
    );
  });
}

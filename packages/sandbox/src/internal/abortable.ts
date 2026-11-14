import type { RuntimeProcess } from "./session.ts";

/**
 * Wait for a promise until the caller's signal aborts.
 *
 * The underlying operation is intentionally not cancelled. This helper only
 * stops waiting for it and rejects with the signal reason.
 */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Kills a started process when the signal aborts, so a timeout or cancellation stops only that command.
 * After an abort, `wait()` rejects with the signal reason.
 */
export function killOnAbort(process: RuntimeProcess, signal: AbortSignal | undefined): RuntimeProcess {
  if (!signal) return process;
  let killed: Promise<void> | undefined;
  const abort = () => {
    killed = process.kill("KILL").catch(() => undefined);
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const exit = process.wait().finally(() => signal.removeEventListener("abort", abort));
  void exit.catch(() => undefined);
  return {
    pid: process.pid,
    stderr: process.stderr,
    get stdin() {
      return process.stdin;
    },
    stdout: process.stdout,
    kill: async signal => await process.kill(signal),
    async wait() {
      const result = await exit;
      if (!killed) return result;
      await killed;
      throw signal.reason;
    },
  };
}

export function sharedBabysitterRead<T, Args extends unknown[]>(read: (signal: AbortSignal, ...args: Args) => Promise<T>) {
  let pending: { result: Promise<T>; controller: AbortController } | undefined;
  return async (caller?: AbortSignal, ...args: Args): Promise<T> => {
    caller?.throwIfAborted();
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      const signal = controller.signal;
      const timer = setTimeout(() => controller.abort(new DOMException("Babysitter read timed out", "TimeoutError")), 15 * 60_000);
      timer.unref?.();
      const timeout = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      const result = Promise.race([Promise.resolve().then(() => {
        signal.throwIfAborted();
        return read(signal, ...args);
      }), timeout]).finally(() => {
        clearTimeout(timer);
        if (pending?.controller === controller) pending = undefined;
      });
      pending = { result, controller };
    }
    const { result, controller } = pending;
    const stop = () => controller.abort(caller?.reason);
    caller?.addEventListener("abort", stop, { once: true });
    try {
      return await result;
    } finally {
      caller?.removeEventListener("abort", stop);
    }
  };
}

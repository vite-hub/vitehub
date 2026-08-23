export function createConsoleRequest(onSuccess: () => void) {
  return async (path: string, options: { signal?: AbortSignal }): Promise<unknown> => {
    const response = await fetch(path, { signal: options.signal });
    if (!response.ok) throw new Error(`Console request failed with status ${response.status}.`);
    const result = await response.json();
    onSuccess();
    return result;
  };
}

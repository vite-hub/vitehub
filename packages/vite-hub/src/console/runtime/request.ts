export function createConsoleRequest() {
  return async (path: string, options: { signal?: AbortSignal }): Promise<unknown> => {
    const response = await fetch(path, { signal: options.signal });
    if (!response.ok) throw new Error(`Console request failed with status ${response.status}.`);
    const result = await response.json();
    return result;
  };
}

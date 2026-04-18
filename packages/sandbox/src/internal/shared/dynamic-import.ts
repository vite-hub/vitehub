export function dynamicImport<T = unknown>(specifier: string): Promise<T> {
  return import(
    /* @vite-ignore */
    specifier
  ) as Promise<T>
}

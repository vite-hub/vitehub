// The ui-sdk examples log their events. The fixture only needs the function.
export function useLog(): (message: string) => void {
  return () => {};
}

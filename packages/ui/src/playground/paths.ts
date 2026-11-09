/** A project-relative file path that stays inside the project on Unix and Windows. */
export function isProjectPath(path: string): boolean {
  return !/[:\\\0]/.test(path) && path.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

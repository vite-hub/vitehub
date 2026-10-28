import { existsSync } from "node:fs"
import { resolve } from "node:path"

const extensions = [".ts", ".mts", ".js", ".mjs"]

/** `server/comments.ts`, or undefined when the app does not define Comments. */
export function findCommentsEntry(projectRoot: string, serverDirs?: readonly string[]): string | undefined {
  for (const directory of serverDirs?.length ? serverDirs : ["server"]) {
    for (const extension of extensions) {
      const file = resolve(projectRoot, directory, `comments${extension}`)
      if (existsSync(file)) return file
    }
  }
}

/** `server/content.ts`, or undefined. Inline edits need it. */
export function findContentEntry(projectRoot: string, serverDirs?: readonly string[]): string | undefined {
  for (const directory of serverDirs?.length ? serverDirs : ["server"]) {
    for (const extension of extensions) {
      const file = resolve(projectRoot, directory, `content${extension}`)
      if (existsSync(file)) return file
    }
  }
}

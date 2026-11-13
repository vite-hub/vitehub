import { defineCollection, glob, files, github, type GitHubSourceOptions } from "vite-hub/source"

const options: GitHubSourceOptions = { repo: "vite-hub/vitehub", include: "docs/**/*.md" }

export const docs = defineCollection({ source: glob("content/docs/**/*.md") })
export const inline = files({ "a.md": "# A" })
export const remote = github(options)

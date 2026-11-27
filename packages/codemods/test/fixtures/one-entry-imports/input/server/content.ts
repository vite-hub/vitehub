import { defineCollection } from "vite-hub/source"
import { glob } from "vite-hub/source/glob"
import { files } from "vite-hub/source/files"
import { github, type GitHubSourceOptions } from "vite-hub/source/github"

const options: GitHubSourceOptions = { repo: "vite-hub/vitehub", include: "docs/**/*.md" }

export const docs = defineCollection({ source: glob("content/docs/**/*.md") })
export const inline = files({ "a.md": "# A" })
export const remote = github(options)

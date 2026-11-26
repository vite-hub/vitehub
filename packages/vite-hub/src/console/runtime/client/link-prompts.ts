import type { ConsoleAccountProject } from "./account"

/** The value that the Repository field of the Link dialog accepts, as an HTML `pattern`: `owner/name` on GitHub. */
export const repositoryPattern = "[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+"

const repository = new RegExp(`^${repositoryPattern}$`)

/** The tag that adds Hosted Comments to a page of a site. A valid `owner/name` repository adds `data-vitehub-repo`. */
export function hostedCommentsScript(origin: string, projectId: string, repo?: string): string {
  const name = repo?.trim()
  const repoAttribute = name && repository.test(name) ? ` data-vitehub-repo="${name}"` : ""
  return `<script type="module" src="${origin}/hosted-comments.js" data-vitehub-comments="${projectId}"${repoAttribute}><${"/script"}>`
}

/** A prompt for a coding agent that adds the Hosted Comments tag to the HTML head of the site. */
export function hostedCommentsPrompt(url: string, script: string): string {
  return `Add ViteHub Hosted Comments to my site at ${url}. Put this script tag in the <head> of every page that people review, and of ${url}, which completes the sign-in. Then deploy the site.\n\n${script}`
}

/** The environment variable line that lets an app accept the signed calls of the Console. */
export function appVariableLine(project: Pick<ConsoleAccountProject, "keyVariable" | "publicKey">): string {
  return `${project.keyVariable}=${project.publicKey}`
}

/** A prompt for a coding agent that connects an app to the Console with its environment variable. */
export function appLinkPrompt(url: string, line: string): string {
  return `Connect my app at ${url} to the ViteHub Console. Set \`console: true\` in its ViteHub config, add this environment variable to its deployment settings, and deploy it again.\n\n${line}`
}

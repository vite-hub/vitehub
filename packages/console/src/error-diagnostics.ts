import { defineDiagnostics } from "nostics"

/** The reason and the HTTP status of a failure of the MCP client of the Console. */
export interface ConsoleMcpFailure {
  message: string
  status: number
}

export const consoleErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    CONSOLE_APP_VITEHUB_OUTDATED: {
      fix: "Upgrade vite-hub in the app to the latest version and deploy it. Until then, the Console page still opens the app.",
      why: ({ version }: { version?: unknown }) => `The app runs vite-hub ${String(version)}, which does not accept this call of the ViteHub MCP. An older app knows fewer fields of the signed caller.`,
    },
    CONSOLE_CONFLICT: {
      why: ({ message }: ConsoleMcpFailure) => message,
      fix: "Reload the Console, then try again.",
      data: ({ status }: ConsoleMcpFailure) => ({ status }),
    },
    CONSOLE_ENV_KEY_MISSING: {
      fix: "Add the key that sealed the value to VITEHUB_CONSOLE_ENV_KEYS after the current key, such as `VITEHUB_CONSOLE_ENV_KEYS=<current key>,<old key>`, in place of VITEHUB_CONSOLE_ENV_KEY, and restart the Console. If the old key is lost, set the value again.",
      why: ({ name, stage }: { name?: unknown, stage?: unknown }) => `A key that this Console does not have sealed ${String(name)} of ${String(stage)}, so it cannot open the value. VITEHUB_CONSOLE_ENV_KEY or VITEHUB_CONSOLE_ENV_KEYS does not hold that key.`,
    },
    CONSOLE_FORWARD_RATE_LIMITED: {
      fix: "Wait the seconds in the Retry-After header, then send the call again. A script or an Agent that calls the app through the Console must wait between calls.",
      why: ({ limit, retryAfter }: { limit?: unknown, retryAfter?: unknown }) => `You sent ${String(limit)} calls to this app through the Console in one minute, which is the most that the Console sends for one person. The next call can go in ${String(retryAfter)} seconds.`,
    },
    CONSOLE_HOSTED_COMMENTS_ACCESS_ENDED: {
      fix: "Sign in to the comments again. A member must still be in the team of the project, and a guest needs an invite pass that is not revoked or expired, from a member who is still in the team.",
      why: "The access of this person to the hosted Comments ended: they left the team, or their invite pass was revoked or expired.",
    },
    CONSOLE_HOSTED_COMMENTS_CODE_INVALID: {
      fix: "Sign in to the comments again. The embed must redeem the code of `#vhc=` once, within 2 minutes, with the PKCE verifier of the challenge that it sent to `/comments/<project>/authorize`.",
      why: "The sign-in code of the hosted Comments is unknown, used, expired, of another project, or the PKCE verifier does not match its challenge.",
    },
    CONSOLE_HOSTED_COMMENTS_DELETE_UNCONFIRMED: {
      fix: "Confirm the unlink in the Console. For the API set deleteHostedComments=true on the DELETE URL. For unlink_app pass deleteHostedComments: true.",
      why: "Unlinking permanently deletes the app's hosted comment threads and replies. You must confirm that deletion.",
    },
    CONSOLE_HOSTED_COMMENTS_NOT_FOUND: {
      fix: "Check the project id in the URL of the embed, and that the project is still in the Console. The Comments API has only the routes of the comments overlay.",
      why: "The Console has no hosted Comments project or route for this URL.",
    },
    CONSOLE_HOSTED_COMMENTS_REQUEST_REFUSED: {
      fix: "Call the hosted Comments API from the embed of the Console origin, with `credentials: \"omit\"`, a JSON body, and `Authorization: Bearer <token>` from `/comments/<project>/redeem`.",
      why: ({ reason }: { reason?: unknown }) => `The Console refused the hosted Comments call: ${String(reason)}`,
    },
    CONSOLE_HOSTED_COMMENTS_RETURN_INVALID: {
      fix: "Leave out `return`, or send the registered project URL without a query or a fragment.",
      why: ({ site }: { site?: unknown }) => `The page that asked for the comments sign-in is not ${String(site)}, the URL of the project in the Console.`,
    },
    CONSOLE_HOSTED_COMMENTS_TOKEN_INVALID: {
      fix: "Sign in to the comments again, so the embed gets a new token. A token lasts 12 hours and works only for its project.",
      why: "The bearer token of the hosted Comments call is missing, unknown, expired, or of another project.",
    },
    CONSOLE_MCP_AUTHORIZATION_FAILED: {
      why: ({ message }: ConsoleMcpFailure) => message,
      fix: "Start the sign-in again. The server must publish RFC 9728 metadata that names an authorization server with client registration.",
      data: ({ status }: ConsoleMcpFailure) => ({ status }),
    },
    CONSOLE_MCP_LIST_TOO_LONG: {
      why: ({ kind }: { kind: string }) => `The MCP server sent more than 20 pages of ${kind}. The Console shows no part of a list that it cannot read fully.`,
      fix: "Make the MCP server send its tools, resources, resource templates, or prompts in 20 pages or fewer, such as with more items in each page.",
      data: { status: 502 },
    },
    CONSOLE_MCP_SIGNED_OUT: {
      why: ({ message }: ConsoleMcpFailure) => message,
      fix: "Sign in again. For a token, connect again with a new one.",
      data: ({ status }: ConsoleMcpFailure) => ({ status }),
    },
    CONSOLE_MCP_UNREACHABLE: {
      why: ({ message }: ConsoleMcpFailure) => message,
      fix: "Check that the server runs and that the URL is its Streamable HTTP endpoint, such as /mcp.",
      data: ({ status }: ConsoleMcpFailure) => ({ status }),
    },
    CONSOLE_NOT_FOUND: {
      why: ({ message }: ConsoleMcpFailure) => message,
      fix: "Reload the Console to see the current data.",
      data: ({ status }: ConsoleMcpFailure) => ({ status }),
    },
    CONSOLE_PROJECT_URL_INVALID: {
      why: ({ value }: { value: string }) => `"${value}" is not a project URL.`,
      fix: "Use the https:// URL of the app, such as https://app.example.com.",
    },
    CONSOLE_PROJECT_URL_PRIVATE: {
      why: ({ hostname }: { hostname: string }) => `${hostname} is a private address. This Console links only apps that it can reach on the public internet.`,
      fix: "Link a public https:// URL of the app: deploy the app, or expose it through a tunnel, such as `cloudflared tunnel --url http://localhost:3000`. On Node.js, set `vitehub({ publicUrl })` to that URL. Only a Console that you run yourself, next to its apps, can link a private address, with VITEHUB_CONSOLE_ALLOW_PRIVATE=true on that Console.",
    },
    CONSOLE_REQUEST_INVALID: {
      why: ({ message }: ConsoleMcpFailure) => message,
      fix: "Reload the Console. If this continues, deploy the Console and the server from the same build.",
      data: ({ status }: ConsoleMcpFailure) => ({ status }),
    },
    CONSOLE_VITE_HUB_BUILD_MISSING: {
      why: ({ file }: { file: string }) => `The Console needs ${file}, which the vite-hub build writes.`,
      fix: "Build vite-hub with `vp run -t vite-hub#build`, then build the Console again.",
    },
  },
})

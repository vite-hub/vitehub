import { oauthProvider } from "@better-auth/oauth-provider"
import { defineHandler } from "h3"
import { DatabaseSync } from "node:sqlite"

import type { BetterAuthPlugin } from "better-auth"
import { jwt } from "better-auth/plugins"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineAuth } from "@vite-hub/auth"
import { createAuthForRequest } from "@vite-hub/auth/server"
import { defineOperation } from "@vite-hub/internal/operations"

import { consoleAuthSignInPage, consoleMcpNativeClients, consoleMcpOAuth, createConsoleAppAuthPages, createConsoleAuthDefinition, defineConsoleAuth, prepareConsoleAuth } from "../src/console/auth.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import type { ConsoleOAuthAuth } from "../src/console/runtime/server/bearer.ts"
import consoleMcpAuthorizationServerHandler from "../src/console/runtime/server/mcp-authorization-server.ts"
import consoleMcpHandler from "../src/console/runtime/server/mcp.ts"
import consoleMcpMetadataHandler from "../src/console/runtime/server/mcp-metadata.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { resolveConsoleAccessBuild } from "../src/console/vite.ts"

const app = "https://app.example.com"
const resource = `${app}/_vitehub/mcp`

const greet = defineOperation({
  description: "Greet someone.",
  input: v.strictObject({ name: v.string() }),
  kind: "read",
  name: "fixture.greet",
  run: ({ name }, { user }) => ({ greeting: `Hello ${name}`, user: user?.email ?? null }),
  section: "fixture",
})

afterEach(() => {
  installConsoleDevelopment("/tmp/console-mcp-auth", false)
  installConsoleAccess({ mode: "open" })
  installConsoleOperations([])
})

/** The Console Auth that ViteHub generates, on a real Better Auth with a SQLite database. */
async function consoleAuth(options: { migrate?: false, plugins?: BetterAuthPlugin[], resource?: string } = {}) {
  const database = new DatabaseSync(":memory:")
  const input = defineConsoleAuth({
    auth: defineAuth(() => ({
      database,
      ...(options.plugins ? { plugins: options.plugins } : {}),
      secret: "test-secret-at-least-32-bytes-long",
      socialProviders: { github: { clientId: "id", clientSecret: "secret" } },
    })),
    authorize: () => true,
    ...(options.migrate === false ? { migrate: false as const } : {}),
    signIn: { provider: "github" },
  })
  const definition = createConsoleAuthDefinition(input, "/", options.resource)
  await prepareConsoleAuth(input, definition, new Request(resource))
  // SAFETY: The registered Auth type does not know the jwt() and oauthProvider() endpoints, which the plugins add at runtime.
  return { auth: (request: Request) => createAuthForRequest(definition, request) as unknown as ConsoleOAuthAuth, database, real: (request: Request) => createAuthForRequest(definition, request) }
}

/** App Auth installs the documented registration hook without a generated Console Auth. */
async function appAuth(plugins: BetterAuthPlugin[]) {
  const database = new DatabaseSync(":memory:")
  const definition = defineAuth(() => ({ baseURL: app, database, plugins, secret: "test-secret-at-least-32-bytes-long" }))
  const real = (request: Request) => createAuthForRequest(definition, request)
  await (await real(new Request(resource)).$context).runMigrations()
  return { database, real }
}

describe("MCP sign-in against a real Better Auth", () => {
  it.each([{ defaults: undefined }, { defaults: [`${app}/other-resource`] }])("rejects a provider without the MCP default registration resource: $defaults", async ({ defaults }) => {
    const { database, real } = await appAuth([
      jwt(),
      oauthProvider({
        clientRegistrationDefaultResources: defaults,
        consentPage: "/consent",
        loginPage: "/login",
        resources: [resource, ...(defaults ?? [])],
        scopes: ["vitehub:read", "vitehub:write"],
      }),
    ])
    try {
      // SAFETY: Better Auth's plugins add the OAuth endpoints to this instance at runtime.
      const auth = (request: Request) => real(request) as unknown as ConsoleOAuthAuth
      installConsoleAccess({ mode: "auth", oauth: { auth, path: "/_vitehub/mcp", resource } })
      for (const handler of [consoleMcpMetadataHandler, consoleMcpAuthorizationServerHandler]) {
        const response = await defineHandler(handler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`))
        expect(response.status).toBe(503)
        await expect(response.json()).resolves.toMatchObject({
          code: "CONSOLE_MCP_OAUTH_INCOMPLETE",
          message: expect.stringContaining("clientRegistrationDefaultResources"),
        })
      }
    }
    finally {
      database.close()
    }
  })

  it.each(["https://login.example.com/", "https://login.example.com/api/auth/", "https://login.example.com/api/auth//"])("rejects the inconsistent Better Auth trailing-slash issuer %s", async (identifier) => {
    const audience = `${resource}/`
    const { database, real } = await appAuth([
      jwt({ jwt: { issuer: identifier } }),
      oauthProvider({ clientRegistrationDefaultResources: [audience], consentPage: "/consent", loginPage: "/login", resources: [audience], scopes: ["vitehub:read", "vitehub:write"] }),
    ])
    try {
      // SAFETY: Better Auth's plugins add the OAuth endpoints to this instance at runtime.
      const auth = (request: Request) => real(request) as unknown as ConsoleOAuthAuth
      const normalized = identifier.replace(/\/$/, "")
      await expect(auth(new Request(resource)).api.getOAuthServerConfig?.({ asResponse: false, headers: new Headers() })).resolves.toMatchObject({ issuer: normalized })
      for (const issuer of [identifier, undefined]) {
        const oauth = resolveConsoleAccessBuild({ auth: {}, mcp: { issuer, resource: audience } }, { handlers: { auth: true, middleware: "/tmp/middleware.mjs" }, root: "/tmp" }).oauth
        if (!oauth) throw new Error("Expected OAuth configuration.")
        installConsoleAccess({ check: async () => new Response("{}", { status: 401 }), mode: "auth", oauth: { ...oauth, auth } })
        const server = await defineHandler(consoleMcpAuthorizationServerHandler).fetch(new Request(`${app}/.well-known/oauth-authorization-server`))
        expect(server.status).toBe(503)
        await expect(server.json()).resolves.toMatchObject({ code: "CONSOLE_MCP_OAUTH_INCOMPLETE", message: expect.stringContaining(identifier.replace(/\/+$/, "")) })
        const metadata = await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`))
        expect(metadata.status).toBe(503)
        await expect(metadata.json()).resolves.toMatchObject({ code: "CONSOLE_MCP_OAUTH_INCOMPLETE", message: expect.stringContaining("issuer") })
      }
    }
    finally {
      database.close()
    }
  })

  it("registers the exact configured resource in generated Console Auth", async () => {
    const audience = `${resource}/`
    const { auth, database, real } = await consoleAuth({ resource: audience })
    try {
      const context = await real(new Request(resource)).$context
      expect(context.getPlugin("oauth-provider")?.options).toMatchObject({ clientRegistrationDefaultResources: [audience], resources: [audience] })
      installConsoleAccess({ check: async () => new Response("{}", { status: 401 }), mode: "auth", oauth: { auth, path: "/_vitehub/mcp", resource: audience } })
      const metadata = await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`))
      expect(metadata.status).toBe(200)
      await expect(metadata.json()).resolves.toMatchObject({ resource: audience })
    }
    finally {
      database.close()
    }
  })

  it("rejects authorization metadata that disagrees with the configured issuer", async () => {
    const { auth, database } = await consoleAuth()
    const issuer = "https://login.example.com/api/auth"
    try {
      installConsoleAccess({ mode: "auth", oauth: { auth, issuer, path: "/_vitehub/mcp", resource } })
      const response = await defineHandler(consoleMcpAuthorizationServerHandler).fetch(new Request(`${app}/.well-known/oauth-authorization-server/api/auth`))
      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_MCP_OAUTH_INCOMPLETE", message: expect.stringContaining("issuer") })
    }
    finally {
      database.close()
    }
  })

  it("serves a configured issuer when Better Auth publishes the same issuer", async () => {
    const issuer = "https://login.example.com/api/auth"
    const { auth, database } = await consoleAuth({ plugins: [jwt({ jwt: { issuer } })] })
    try {
      installConsoleAccess({ mode: "auth", oauth: { auth, issuer, path: "/_vitehub/mcp", resource } })
      const response = await defineHandler(consoleMcpAuthorizationServerHandler).fetch(new Request(`${app}/.well-known/oauth-authorization-server/api/auth`))
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ issuer })
    }
    finally {
      database.close()
    }
  })

  it("verifies a token that the Console Auth signed, reading keys and the user in-process", async () => {
    const { auth, database, real } = await consoleAuth()
    try {
      const instance = real(new Request(resource))
      const context = await instance.$context
      expect(context.getPlugin("jwt")).toBeTruthy()
      expect(context.getPlugin("oauth-provider")).toBeTruthy()
      const user = await context.internalAdapter.createUser({ email: "ada@example.com", emailVerified: true, name: "Ada" }, undefined as never)
      // SAFETY: The test reads the plugin endpoint that the jwt() plugin adds to the instance.
      const signed = await (instance.api as unknown as { signJWT: (input: { body: Record<string, unknown> }) => Promise<{ token: string }> }).signJWT({
        // The OAuth provider signs its access tokens with the issuer of the Auth, its baseURL with the base path.
        body: { overrideOptions: { jwt: { expirationTime: "5m" } }, payload: { aud: resource, iss: context.baseURL, scope: "vitehub:read", sub: user.id } },
      })
      installConsoleOperations([{ operations: [greet], plugin: "fixture" }])
      installConsoleAccess({ authorize: ({ user: person }) => person?.email === "ada@example.com", check: async () => new Response("{}", { status: 401 }), mode: "auth", oauth: { auth, path: "/_vitehub/mcp" } })
      installConsoleDevelopment("/tmp/console-mcp-auth", true)
      const answer = await defineHandler(consoleMcpHandler).fetch(new Request(resource, {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: { name: "Ada" }, name: "fixture_greet" } }),
        headers: { "authorization": `Bearer ${signed.token}`, "content-type": "application/json" },
        method: "POST",
      }))
      installConsoleDevelopment("/tmp/console-mcp-auth", false)
      expect(answer.status).toBe(200)
      await expect(answer.json()).resolves.toMatchObject({ result: { structuredContent: { greeting: "Hello Ada", user: "ada@example.com" } } })
      // The metadata names the issuer of the real instance, and Better Auth's metadata is served at the root.
      const metadata = await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`, { headers: {} }))
      expect(metadata.status).toBe(503)
      await expect(metadata.json()).resolves.toMatchObject({ code: "CONSOLE_MCP_ORIGIN_REQUIRED" })
      installConsoleAccess({ check: async () => new Response("{}", { status: 401 }), mode: "auth", oauth: { auth, path: "/_vitehub/mcp", resource } })
      const configured = await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`))
      await expect(configured.json()).resolves.toMatchObject({ authorization_servers: [`${app}/api/_vitehub/console/auth`], resource })
      const server = await defineHandler(consoleMcpAuthorizationServerHandler).fetch(new Request(`${app}/.well-known/oauth-authorization-server/api/_vitehub/console/auth`))
      expect(server.status).toBe(200)
      await expect(server.json()).resolves.toMatchObject({ issuer: `${app}/api/_vitehub/console/auth`, scopes_supported: expect.arrayContaining(["vitehub:read", "vitehub:write"]) })
    }
    finally {
      vi.unstubAllEnvs()
      database.close()
    }
  })

  it.each(["generated", "supplied", "managed", "app"] as const)("lets an MCP client register itself with a %s OAuth provider", async (provider) => {
    const supplied = oauthProvider({
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultResources: [resource],
      consentPage: "/custom-consent",
      loginPage: "/custom-login",
      resources: [resource],
      scopes: ["openid", "vitehub:read", "vitehub:write"],
    })
    const { database, real } = provider === "app"
      ? await appAuth([jwt(), supplied, consoleMcpNativeClients()])
      : await consoleAuth(provider === "generated" ? {} : {
          ...(provider === "managed" ? { migrate: false as const } : {}),
          plugins: [jwt(), supplied],
        })
    try {
      const context = await real(new Request(resource)).$context
      if (provider !== "generated") {
        expect(context.getPlugin("oauth-provider")).toBe(supplied)
        expect(context.options.plugins?.filter(plugin => plugin.id === "oauth-provider")).toHaveLength(1)
      }
      // A managed Auth provisions its own OAuth tables instead of ViteHub running migrations.
      if (provider === "managed") await context.runMigrations()
      const register = (body: Record<string, unknown>) => real(new Request(resource)).handler(new Request(`${context.baseURL}/oauth2/register`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", "origin": app },
        method: "POST",
      }))
      const response = await register({ client_name: "Claude Code", redirect_uris: ["http://localhost:53682/callback"], token_endpoint_auth_method: "none" })
      expect(response.status, await response.clone().text()).toBe(201)
      const registration = await response.json()
      expect(registration).toMatchObject({ application_type: "native", client_name: "Claude Code" })
      const client = v.parse(v.object({ client_id: v.string() }), registration)
      // Standard MCP registration omits Better Auth's resources field. The client must still be linked to MCP.
      for (const target of [resource, `${app}/other-resource`]) {
        const query = new URLSearchParams({
          client_id: client.client_id,
          code_challenge: "a".repeat(43),
          code_challenge_method: "S256",
          prompt: "none",
          redirect_uri: "http://localhost:53682/callback",
          resource: target,
          response_type: "code",
          scope: "vitehub:read",
          state: "mcp-registration-test",
        })
        const authorization = await real(new Request(resource)).handler(new Request(`${context.baseURL}/oauth2/authorize?${query}`))
        if (target !== resource) {
          expect(authorization.status).toBe(400)
          await expect(authorization.json()).resolves.toMatchObject({ error: "invalid_target" })
          continue
        }
        expect(authorization.status, await authorization.clone().text()).toBe(302)
        const redirect = new URL(authorization.headers.get("location") ?? "")
        expect(redirect.origin).toBe("http://localhost:53682")
        expect(redirect.searchParams.get("error")).toBe("login_required")
      }
      // A web client keeps its type, and its https redirect.
      const web = await register({ client_name: "Web", redirect_uris: ["https://client.example.com/callback"], token_endpoint_auth_method: "none" })
      expect(web.status).toBe(201)
      await expect(web.json()).resolves.toMatchObject({ application_type: "web" })
      const explicitWeb = await register({ application_type: "web", client_name: "Explicit web", redirect_uris: ["http://localhost:53682/callback"], token_endpoint_auth_method: "none" })
      expect(explicitWeb.status).toBe(400)
    }
    finally {
      database.close()
    }
  })

  it("completes app Auth with consoleMcpOAuth(), and keeps its issuer and resource on another host", async () => {
    const database = new DatabaseSync(":memory:")
    // `baseURL: requestOrigin` follows the request, so a preview host would otherwise issue tokens that the Console rejects.
    const definition = defineAuth(({ requestOrigin }) => ({ baseURL: requestOrigin, database, plugins: consoleMcpOAuth({ loginPage: "/login", resource }), secret: "test-secret-at-least-32-bytes-long" }))
    const real = (request: Request) => createAuthForRequest(definition, request)
    const preview = "https://preview.example.com"
    try {
      await (await real(new Request(resource)).$context).runMigrations()
      // SAFETY: Better Auth's plugins add the OAuth endpoints to this instance at runtime.
      const auth = (request: Request) => real(request) as unknown as ConsoleOAuthAuth
      installConsoleAccess({ mode: "auth", oauth: { auth, path: "/_vitehub/mcp", resource } })
      const metadata = await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`))
      expect(metadata.status, await metadata.clone().text()).toBe(200)
      await expect(metadata.json()).resolves.toMatchObject({ authorization_servers: [`${app}/api/auth`], resource })
      await expect(auth(new Request(`${preview}/_vitehub/mcp`)).api.getOAuthServerConfig?.({ asResponse: false, headers: new Headers() })).resolves.toMatchObject({ issuer: `${app}/api/auth` })
      const context = await real(new Request(`${preview}/_vitehub/mcp`)).$context
      expect(context.getPlugin("oauth-provider")?.options).toMatchObject({ clientRegistrationDefaultResources: [resource], consentPage: "/login", loginPage: "/login", resources: [resource] })
      const registration = await real(new Request(`${preview}/_vitehub/mcp`)).handler(new Request(`${preview}/api/auth/oauth2/register`, {
        body: JSON.stringify({ client_name: "Claude Code", redirect_uris: ["http://localhost:53682/callback"], token_endpoint_auth_method: "none" }),
        headers: { "content-type": "application/json", "origin": preview },
        method: "POST",
      }))
      expect(registration.status, await registration.clone().text()).toBe(201)
      await expect(registration.json()).resolves.toMatchObject({ application_type: "native" })
    }
    finally {
      database.close()
    }
  })

  it("signs an agent in and asks for consent on the built-in app Auth page by default", async () => {
    const database = new DatabaseSync(":memory:")
    const definition = defineAuth(() => ({ baseURL: app, database, emailAndPassword: { enabled: true }, plugins: consoleMcpOAuth({ resource }), secret: "test-secret-at-least-32-bytes-long" }))
    const real = (request: Pick<Request, "headers" | "url">) => createAuthForRequest(definition, request)
    const call = (path: string, init: RequestInit = {}) => real(new Request(resource)).handler(new Request(`${app}/api/auth${path}`, init))
    const post = (path: string, body: Record<string, unknown>, cookie = "") => call(path, { body: JSON.stringify(body), headers: { "content-type": "application/json", cookie, origin: app }, method: "POST" })
    const pages = createConsoleAppAuthPages(real)
    try {
      await (await real(new Request(resource)).$context).runMigrations()
      expect((await post("/sign-up/email", { email: "ada@example.com", name: "Ada", password: "test-password-123" })).status).toBe(200)
      const registration = await post("/oauth2/register", { client_name: "Claude Code", redirect_uris: ["http://localhost:53682/callback"], token_endpoint_auth_method: "none" })
      const { client_id } = v.parse(v.object({ client_id: v.string() }), await registration.json())
      const query = new URLSearchParams({ client_id, code_challenge: "a".repeat(43), code_challenge_method: "S256", redirect_uri: "http://localhost:53682/callback", resource, response_type: "code", scope: "vitehub:read vitehub:write", state: "built-in-page" })
      const login = new URL((await call(`/oauth2/authorize?${query}`)).headers.get("location") ?? "", app)
      expect(login.pathname).toBe("/_vitehub/sign-in")
      const page = await pages.signIn({ req: new Request(login) })
      const html = await page.text()
      expect(html).toContain("Connect an agent")
      expect(html).toContain('autocomplete="current-password"')
      expect(html).toContain('const authBase = "/api/auth"')
      // The page posts the signed query with the email and password, then with the answer, as its script does.
      const oauthQuery = login.search.slice(1)
      const signedIn = await post("/sign-in/email", { email: "ada@example.com", oauth_query: oauthQuery, password: "test-password-123" })
      expect(signedIn.status, await signedIn.clone().text()).toBe(200)
      const consent = new URL(v.parse(v.object({ url: v.string() }), await signedIn.json()).url, app)
      expect(consent.pathname).toBe("/_vitehub/sign-in")
      const cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
      const answer = await post("/oauth2/consent", { accept: true, oauth_query: consent.search.slice(1) }, cookie)
      expect(answer.status, await answer.clone().text()).toBe(200)
      const callback = new URL(v.parse(v.object({ url: v.string() }), await answer.json()).url)
      expect(callback.origin).toBe("http://localhost:53682")
      expect(callback.searchParams.get("state")).toBe("built-in-page")
      expect(callback.searchParams.get("code")).toBeTruthy()
    }
    finally {
      database.close()
    }
  })

  it("keeps supplied plugins, and adds no OAuth schema with migrate false", async () => {
    const own = await consoleAuth({ plugins: [{ id: "jwt", options: { jwt: { issuer: "https://login.example.com" } } }, consoleMcpNativeClients()] })
    try {
      const context = await own.real(new Request(resource)).$context
      expect(context.options.plugins?.filter(plugin => plugin.id === "jwt")).toHaveLength(1)
      expect(context.getPlugin("oauth-provider")).toBeTruthy()
      expect(context.options.plugins?.filter(plugin => plugin.id === "vitehub-console-native-clients")).toHaveLength(1)
    }
    finally {
      own.database.close()
    }
    const managed = await consoleAuth({ migrate: false })
    try {
      const context = await managed.real(new Request(resource)).$context
      expect(context.getPlugin("jwt")).toBeFalsy()
      expect(context.getPlugin("oauth-provider")).toBeFalsy()
      expect(context.getPlugin("vitehub-console-native-clients")).toBeFalsy()
    }
    finally {
      managed.database.close()
    }
  })

  it("serves the login and consent page for a signed OAuth query, and the sign-in page otherwise", async () => {
    const signedIn = consoleAuthSignInPage("github", new Request(`${app}/_vitehub/sign-in?client_id=abc&sig=xyz&ba_param=client_id&ba_param=sig`), "/portal/")
    const page = await signedIn.text()
    expect(signedIn.headers.get("content-security-policy")).toContain("script-src 'nonce-")
    expect(page).toContain("Connect an agent")
    expect(page).toContain('"/portal/api/_vitehub/console/auth"')
    expect(page).toContain("/oauth2/consent")
    expect(await consoleAuthSignInPage("github", new Request(`${app}/_vitehub/sign-in`), "/portal/").text()).not.toContain("oauth2/consent")
  })
})

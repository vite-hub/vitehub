import { describe, expect, it } from "vitest"
import { consumeAuthorization, consumeCredentialAssignment, credentialTextMayContinue, pendingAuthorizationState, pendingCredentialAssignment, pendingCredentialAssignmentState, pendingCredentialQuote, pendingCredentialScheme, pendingCredentialTextSuffix, redactCredentialText } from "../src/internal/credential-redaction.ts"
import { getAgentTelemetryConfiguration, safeAgentTelemetryMetadata, setAgentTelemetryConfiguration } from "../src/internal/agent-telemetry.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"

describe("structured credential redaction", () => {
  it.each(["Bearer", "Basic", "Authorization: bearer", "Proxy-Authorization: BASIC"])("redacts quoted %s values", (scheme) => {
    for (const quote of ['"', "'"]) {
      const prefix = `${scheme} ${quote}`
      expect(redactCredentialText(`${prefix}sensitive token${quote};status=ok`)).toBe(`${prefix}[REDACTED]${quote};status=ok`)
      expect(redactCredentialText(`${prefix}sensitive\\${quote} token${quote};status=ok`)).toBe(`${prefix}[REDACTED]${quote};status=ok`)
      expect(redactCredentialText(`${prefix}sensitive token`)).toBe(`${prefix}[REDACTED]`)
      expect(pendingCredentialQuote(`${prefix}sensitive token`)).toBe(quote)
      expect(credentialTextMayContinue(`${prefix}sensitive token`)).toBe(true)
      expect(pendingCredentialQuote(`${prefix}sensitive token${quote};status=ok`)).toBeUndefined()
    }
  })

  it("preserves quoted basic prose and uses preceding authorization context", () => {
    expect(redactCredentialText('Use basic "example words"')).toBe('Use basic "example words"')
    expect(pendingCredentialQuote('basic "example', "Use ")).toBeUndefined()
    expect(pendingCredentialQuote('basic "secret', "Authorization: ")).toBe('"')
    expect(redactCredentialText('basic "secret words"', "Authorization: ")).toBe('basic "[REDACTED]"')
  })

  it.each([
    ['PASSWORD="correct horse battery staple";status=ok', 'PASSWORD="[REDACTED]";status=ok'],
    ["SECRET='correct horse & battery, staple';status=ok", "SECRET='[REDACTED]';status=ok"],
    ['PASSWORD="unfinished secret words', 'PASSWORD="[REDACTED]'],
    ["Bearer sensitive-value&status=ok", "Bearer [REDACTED]&status=ok"],
    ["Basic sensitive-value&status=ok", "Basic [REDACTED]&status=ok"],
    ["API_TOKEN=sensitive-value&status=ok", "API_TOKEN=[REDACTED]&status=ok"],
    ['{"authorization":"Bearer sensitive-value","status":"ok"}', '{"authorization":"Bearer [REDACTED]","status":"ok"}'],
    ["'Basic sensitive-value', status=ok", "'Basic [REDACTED]', status=ok"],
    ['API_TOKEN="sensitive-value";status=ok', 'API_TOKEN="[REDACTED]";status=ok'],
    ["API_TOKEN=sensitive-value,status=ok", "API_TOKEN=[REDACTED],status=ok"],
    ["password=sensitive-value,status=ok", "password=[REDACTED],status=ok"],
    ["apiToken=sensitive-value;status=ok", "apiToken=[REDACTED];status=ok"],
    ['secret="sensitive-value",status=ok', 'secret="[REDACTED]",status=ok'],
    ["PASSWORD=sensitive-value,status=ok", "PASSWORD=[REDACTED],status=ok"],
    ["Bearer sensitive-value<status>ok</status>", "Bearer [REDACTED]<status>ok</status>"],
  ])("preserves the non-secret suffix of %s", (input, expected) => {
    expect(redactCredentialText(input)).toBe(expected)
    expect(credentialTextMayContinue(input)).toBe(input.includes("unfinished"))
  })

  it.each(["Bearer sensitive", "Basic sensitive", "API_TOKEN=sensitive", "password=sensitive", "apiToken=sensitive", "secret=", "apiToken=", 'API_TOKEN="sensitive'])(
    "buffers the unfinished credential %s",
    (input) => expect(credentialTextMayContinue(input)).toBe(true),
  )
})

describe("credential key boundaries", () => {
  it.each(["monkey", "hockey", "turnkey", "MONKEY", "HOCKEY", "TURNKEY", "Hockey", "donkey"])("preserves ordinary %s assignments", (key) => {
    for (const value of ["banana", '"banana', "'banana", '"banana with spaces"']) {
      const input = `${key}=${value}`
      expect(redactCredentialText(input)).toBe(input)
      expect(credentialTextMayContinue(input)).toBe(false)
      expect(pendingCredentialQuote(input)).toBeUndefined()
    }
  })

  it.each(["key", "KEY", "api_key", "API_KEY", "apiKey", "apiKEY", "clientSecret", "accessToken", "dbPassword"])("redacts credential %s assignments", (key) => {
    expect(redactCredentialText(`${key}=sensitive`)).toBe(`${key}=[REDACTED]`)
    expect(redactCredentialText(`${key}="sensitive words`)).toBe(`${key}="[REDACTED]`)
    expect(credentialTextMayContinue(`${key}=sensitive`)).toBe(true)
    expect(pendingCredentialQuote(`${key}="sensitive words`)).toBe('"')
  })
})

it.each(["apiToken", "apiTOKEN", "clientSecret", "dbPassword", "accessKey", "oauth2Token"])("retains split credential suffixes in %s", (key) => {
  const markerStart = key.search(/[A-Z]/)
  for (let split = markerStart + 1; split <= key.length; split++) {
    const prefix = key.slice(0, split)
    expect(credentialTextMayContinue(`${".".repeat(512)}${prefix}`)).toBe(true)
    expect(redactCredentialText(`${prefix}${key.slice(split)}=sensitive;status=ok`)).toBe(`${key}=[REDACTED];status=ok`)
  }
})

it.each([
  "APIKEY", "ACCESSKEY", "PRIVATEKEY", "SECRETKEY", "PUBLICKEY",
  "ACCESSTOKEN", "AUTHTOKEN", "REFRESHTOKEN", "CLIENTSECRET", "SESSIONTOKEN",
].flatMap(key => [key, key.toLowerCase(), key[0] + key.slice(1).toLowerCase()]))("redacts conventional %s credentials and retains split names", (key) => {
  expect(redactCredentialText(`${key}=sensitive;status=ok`)).toBe(`${key}=[REDACTED];status=ok`)
  for (const quote of ['"', "'"]) {
    expect(redactCredentialText(`${key}=${quote}sensitive words${quote};status=ok`)).toBe(`${key}=${quote}[REDACTED]${quote};status=ok`)
    expect(pendingCredentialQuote(`${key}=${quote}sensitive words`)).toBe(quote)
  }
  expect(credentialTextMayContinue(`${key}=sensitive`)).toBe(true)
  expect(pendingCredentialAssignment(`${key}=`)).toBe("assignment")
  expect(pendingCredentialAssignment(`${key}=sensitive`)).toBe("unquoted")
  expect(redactCredentialText(`{"${key}":"sensitive","status":"ok"}`)).toBe(`{"${key}":"[REDACTED]","status":"ok"}`)
  for (let split = 1; split <= key.length; split++) {
    expect(credentialTextMayContinue(`${".".repeat(512)}${key.slice(0, split)}`)).toBe(true)
  }
})

it.each([
  "This is a basic example",
  "Use basic authentication",
  "A basic tutorial;status=ok",
])("preserves ordinary prose: %s", (text) => {
  expect(redactCredentialText(text)).toBe(text)
  expect(credentialTextMayContinue(text)).toBe(false)
})

it.each(["Authorization: Basic", "Basic", "Bearer", "bearer", "BEARER", "bEaReR", "basic", "BASIC", "Authorization: bearer", "Authorization: BEARER"])("keeps credential redaction for %s", (scheme) => {
  expect(redactCredentialText(`${scheme} sensitive-value;status=ok`)).toBe(`${scheme} [REDACTED];status=ok`)
  expect(credentialTextMayContinue(`${scheme} sensitive-value`)).toBe(true)
})

it.each(["basic", "BASIC", "bAsIc"])("redacts contextual %s authorization across boundaries", (scheme) => {
  for (const header of ["Authorization: ", "proxy-authorization: ", '"authorization":"']) {
    expect(redactCredentialText(`${header}${scheme} c2VjcmV0;status=ok`)).toBe(`${header}${scheme} [REDACTED];status=ok`)
    expect(pendingCredentialScheme(`${header}${scheme} c2Vj`)).toBe("unquoted")
    expect(pendingCredentialScheme(`${header}${scheme} `)).toBe("scheme")
    for (let split = 1; split <= scheme.length; split++) {
      const prefix = `${header}${scheme.slice(0, split)}`
      expect(credentialTextMayContinue(prefix)).toBe(true)
      expect(pendingCredentialTextSuffix(`${".".repeat(512)}${prefix}`)).toBe(prefix)
    }
  }
})

it.each([
  ['{"password":"sensitive-value","status":"ok"}', '{"password":"[REDACTED]","status":"ok"}'],
  ["api_token: sensitive-value;status=ok", "api_token: [REDACTED];status=ok"],
  ['password = "correct horse";status=ok', 'password = "[REDACTED]";status=ok'],
  ["API_TOKEN = sensitive-value", "API_TOKEN = [REDACTED]"],
  ["'secret' : 'private & words';status=ok", "'secret' : '[REDACTED]';status=ok"],
  ["monkey : banana", "monkey : banana"],
  ["command=PASSWORD=sensitive", "command=PASSWORD=[REDACTED]"],
])("redacts structured and spaced assignments: %s", (text, expected) => {
  expect(redactCredentialText(text)).toBe(expected)
})

it.each(['"password" : ', "password = ", "API_TOKEN\t=\t", "api_token: "])("retains structured assignment state: %s", (prefix) => {
  expect(pendingCredentialAssignment(prefix)).toBe("assignment")
  expect(pendingCredentialAssignment(`${prefix}sensitive`)).toBe("unquoted")
  expect(pendingCredentialQuote(`${prefix}"secret words`)).toBe('"')
  expect(credentialTextMayContinue(prefix)).toBe(true)
  const key = prefix.replace(/[:=]\s*$/, "")
  expect(credentialTextMayContinue(key)).toBe(true)
  expect(pendingCredentialTextSuffix(`${".".repeat(512)}${key}`)).toBe(key)
})

it.each(["Authorization: ", "Proxy-Authorization: ", '"authorization":"'])("retains every incomplete header prefix in %s", (header) => {
  for (let split = 1; split <= header.length; split++) {
    const prefix = header.slice(0, split)
    if (prefix === '"') continue
    expect(credentialTextMayContinue(`${".".repeat(512)}${prefix}`)).toBe(true)
    expect(pendingCredentialTextSuffix(`${".".repeat(512)}${prefix}`)).toBe(prefix)
  }
})

it.each([
  '{"token":"identifier"}',
  '{"key":"identifier"}',
  "Parser error. Token: identifier",
  "Parser error. Key: identifier",
  "Field label. Password: identifier",
  "Field label. Secret: identifier",
])("preserves ambiguous colon fields: %s", (text) => {
  expect(redactCredentialText(text)).toBe(text)
  expect(pendingCredentialAssignment(text)).toBeUndefined()
  expect(pendingCredentialQuote(text)).toBeUndefined()
})

it("redacts a project token embedded in provider tool metadata", () => {
  const input = 'You are currently in project "Default project" (id: 145757, token: project-token-value).'
  expect(redactCredentialText(input)).toBe('You are currently in project "Default project" (id: 145757, token: [REDACTED]).')
  expect(safeAgentTelemetryMetadata({
    tools: [{ inputSchema: { properties: { command: { description: input } } } }],
  })).toEqual({
    tools: [{
      inputSchema: {
        properties: {
          command: { description: 'You are currently in project "Default project" (id: 145757, token: [REDACTED]).' },
        },
      },
    }],
  })
})

it("redacts recognized PostHog tokens throughout persisted agent configuration", async () => {
  const context = createAgentInvocationContextStore()
  const token = "phc_fake_project_token_123456789"
  await setAgentTelemetryConfiguration(context, {
    capabilities: [],
    driver: { kind: "provider" },
    tools: [{ inputSchema: { properties: { command: { description: `Active project token: ${token}` } } }, name: "exec" }],
  } as never)
  const serialized = JSON.stringify(getAgentTelemetryConfiguration(context)?.value)
  expect(serialized).not.toContain(token)
  expect(serialized).toContain("[REDACTED]")
})

it.each(["token", "key", "Token", "Key"])("does not start redaction for ambiguous structured %s fields", (key) => {
  expect(pendingCredentialAssignment(`"${key}":`)).toBeUndefined()
  expect(pendingCredentialQuote(`"${key}":"identifier`)).toBeUndefined()
  expect(redactCredentialText(`"${key}":"identifier`)).toBe(`"${key}":"identifier`)
  expect(redactCredentialText(`${key}=sensitive`)).toBe(`${key}=[REDACTED]`)
})

it("recognizes a quoted credential key after its opening quote was flushed", () => {
  expect(redactCredentialText('password":"sensitive words"}')).toBe('password":"[REDACTED]"}')
  expect(pendingCredentialAssignment('password":')).toBe("assignment")
  expect(pendingCredentialQuote('password":"sensitive')).toBe('"')
})

it.each(["X-API-Key", "api-key", "x-access-token", "client-secret", "X-API-KEY"])("redacts hyphenated %s credentials and retains every name prefix", (key) => {
  expect(redactCredentialText(`${key}: sensitive-value;status=ok`)).toBe(`${key}: [REDACTED];status=ok`)
  expect(redactCredentialText(`"${key}":"sensitive-value"`)).toBe(`"${key}":"[REDACTED]"`)
  expect(pendingCredentialAssignment(`${key}: sensitive`)).toBe("unquoted")
  expect(pendingCredentialQuote(`"${key}":"sensitive`)).toBe('"')
  for (let split = 1; split <= key.length; split++) {
    const prefix = key.slice(0, split)
    expect(credentialTextMayContinue(`${".".repeat(512)}${prefix}`)).toBe(true)
    expect(pendingCredentialTextSuffix(`${".".repeat(512)}${prefix}`)).toBe(prefix)
  }
})

it.each(["api-key", "x-access-token", "password", "API_TOKEN"])("redacts CLI credential flag --%s", (key) => {
  expect(redactCredentialText(`--${key}=sensitive;status=ok`)).toBe(`--${key}=[REDACTED];status=ok`)
  expect(redactCredentialText(`command --${key}="sensitive words" --verbose`)).toBe(`command --${key}="[REDACTED]" --verbose`)
  expect(pendingCredentialAssignment(`--${key}=`)).toBe("assignment")
  expect(pendingCredentialAssignment(`--${key}=sensitive`)).toBe("unquoted")
  expect(pendingCredentialQuote(`--${key}="sensitive`)).toBe('"')
})

it.each(["--monkey=banana", "--hockey=game", "--turnkey=ready"])("preserves unrelated CLI assignments: %s", (text) => {
  expect(redactCredentialText(text)).toBe(text)
  expect(pendingCredentialAssignment(text)).toBeUndefined()
})

it.each(["-", "--"])("retains an incomplete CLI flag prefix %s", (prefix) => {
  expect(credentialTextMayContinue(`${".".repeat(512)}${prefix}`)).toBe(true)
  expect(pendingCredentialTextSuffix(`${".".repeat(512)}${prefix}`)).toBe(prefix)
})

it.each(["api-key", "password", "x-access-token"])("redacts whitespace-delimited --%s values", (key) => {
  expect(redactCredentialText(`--${key} sensitive-value;status=ok`)).toBe(`--${key} [REDACTED];status=ok`)
  expect(redactCredentialText(`--${key} "correct horse" --verbose`)).toBe(`--${key} "[REDACTED]" --verbose`)
  expect(pendingCredentialAssignment(`--${key} `)).toBe("assignment")
  expect(pendingCredentialQuote(`--${key} "correct`)).toBe('"')
  expect(pendingCredentialTextSuffix(`--${key}`)).toBe(`--${key}`)
})

it.each(["sort --key=1,1", "sort --key 1,1", 'sort --key="1,1"', "Parser token identifier"])("preserves generic arguments: %s", (text) => {
  expect(redactCredentialText(text)).toBe(text)
})

it("retains the CLI prefix when its name also prefixes an authorization header", () => {
  expect(pendingCredentialTextSuffix(`${".".repeat(512)}--a`)).toBe("--a")
  expect(redactCredentialText("token --api-key sensitive")).toBe("token --api-key [REDACTED]")
})

it.each(["=", " "])("redacts conventional token flags with separator %s", (separator) => {
  expect(redactCredentialText(`--token${separator}sensitive;status=ok`)).toBe(`--token${separator}[REDACTED];status=ok`)
  expect(redactCredentialText(`--token${separator}"sensitive words"`)).toBe(`--token${separator}"[REDACTED]"`)
  expect(pendingCredentialAssignment(`--token${separator}`)).toBe("assignment")
  expect(pendingCredentialAssignment(`--token${separator}sensitive`)).toBe("unquoted")
  expect(pendingCredentialQuote(`--token${separator}"sensitive`)).toBe('"')
  expect(redactCredentialText(`sort --key${separator}1,1`)).toBe(`sort --key${separator}1,1`)
})

it.each([
  [String.raw`PASSWORD=correct\ horse battery`, "PASSWORD=[REDACTED] battery"],
  [String.raw`API_TOKEN=abc\;def;status=ok`, "API_TOKEN=[REDACTED];status=ok"],
  [String.raw`--token abc\,def,status=ok`, "--token [REDACTED],status=ok"],
  [String.raw`PASSWORD=abc\\;status=ok`, "PASSWORD=[REDACTED];status=ok"],
])("redacts escaped unquoted values: %s", (text, expected) => {
  expect(redactCredentialText(text)).toBe(expected)
})

it.each([String.raw`PASSWORD=correct\ horse`, String.raw`API_TOKEN=abc\;def`, "--token abc\\"])("retains escaped credential continuation: %s", (text) => {
  expect(pendingCredentialAssignment(text)).toBe("unquoted")
  expect(credentialTextMayContinue(text)).toBe(true)
})

it("ends unquoted credentials after an even number of backslashes", () => {
  expect(pendingCredentialAssignment(String.raw`PASSWORD=abc\\;`)).toBeUndefined()
  expect(pendingCredentialAssignment(String.raw`PASSWORD=abc\\;status=ok`)).toBeUndefined()
})

it.each(["Bearer", "Basic", "Authorization: bearer", "Proxy-Authorization: basic"])("redacts escaped scheme values for %s", (scheme) => {
  for (const separator of [" ", ";", ","]) {
    const escaped = `${scheme} abc\\${separator}private`
    expect(redactCredentialText(`${escaped};status=ok`)).toBe(`${scheme} [REDACTED];status=ok`)
    expect(pendingCredentialScheme(escaped)).toBe("unquoted")
    expect(pendingCredentialScheme(`${scheme} abc\\`)).toBe("unquoted")
    const paired = `${scheme} abc\\\\;status=ok`
    expect(redactCredentialText(paired)).toBe(`${scheme} [REDACTED];status=ok`)
    expect(pendingCredentialScheme(paired)).toBeUndefined()
  }
})

it.each(["The bearer of good news arrived", "A basic explanation follows"])("preserves ordinary scheme prose: %s", (text) => {
  expect(redactCredentialText(text)).toBe(text)
  expect(pendingCredentialScheme(text)).toBeUndefined()
})

it.each(["bearer", "BEARER", "bEaReR", "basic", "BASIC", "bAsIc"])("redacts bare scheme lines: %s", (scheme) => {
  const prefix = `launcher failed\n  ${scheme} `
  expect(redactCredentialText(`${prefix}sensitive-value;status=ok`)).toBe(`${prefix}[REDACTED];status=ok`)
  expect(pendingCredentialScheme(`${prefix}sensitive`)).toBe("unquoted")
})

it("keeps preceding prose context across scheme detection boundaries", () => {
  expect(redactCredentialText("bearer of good news", "The ")).toBe("bearer of good news")
  expect(pendingCredentialScheme("bearer of", "The ")).toBeUndefined()
  expect(redactCredentialText("bearer sensitive-value", "launcher failed\n")).toBe("bearer [REDACTED]")
})

it.each([
  [String.raw`SECRET='abc\';status=ok`, "SECRET='[REDACTED]';status=ok"],
  [String.raw`SECRET=abc'def\';status=ok`, "SECRET=[REDACTED];status=ok"],
  ['PASSWORD=abc"def ghi"jkl;status=ok', 'PASSWORD=[REDACTED];status=ok'],
  ["SECRET=abc'def ghi'jkl;status=ok", "SECRET=[REDACTED];status=ok"],
  ['PASSWORD="abc"def"ghi jkl"mno;status=ok', 'PASSWORD="[REDACTED]";status=ok'],
  [String.raw`PASSWORD=abc\"def"ghi jkl"mno;status=ok`, 'PASSWORD=[REDACTED];status=ok'],
])("redacts every adjacent shell segment in %s", (input, expected) => {
  expect(redactCredentialText(input)).toBe(expected)
  const end = input.indexOf(";status=ok")
  for (let split = input.indexOf("=") + 1; split <= end; split++) {
    const state = pendingCredentialAssignmentState(input.slice(0, split))!
    expect(state).toBeDefined()
    const rest = input.slice(split)
    expect(rest.slice(consumeCredentialAssignment(rest, state))).toBe(";status=ok")
  }
})

it("keeps a closed marker-like credential attached to its assignment", () => {
  const text = `${".".repeat(512)}PASSWORD="secret"`
  expect(pendingCredentialAssignmentState(text)).toEqual({ escaped: false, started: true })
  expect(redactCredentialText(text)).toBe(`${".".repeat(512)}PASSWORD="[REDACTED]"`)
})


it.each([
  ["Authorization: ", "ghp_sensitive", ";status=ok"],
  ["Authorization: ", "ghp_sensitive status=private", "\nstatus=ok"],
  ["Authorization: ", "x".repeat(300), "\nstatus=ok"],
  ["Proxy-Authorization: ", "raw-token+/=", "\nstatus=ok"],
  ['{"authorization":"', "sensitive-value", '", "status":"ok"}'],
  ["Authorization: token ", "ghp_sensitive", ";status=ok"],
  ["Authorization: ApiKey ", "sensitive-value", "\nstatus=ok"],
  ["Proxy-Authorization: Digest ", 'username="private", realm="hidden", response="sensitive"', ";status=ok"],
  ['{"authorization":"', "Custom-Auth sensitive-value", '", "status":"ok"}'],
])("redacts explicit %s headers across every credential boundary", (prefix, credential, suffix) => {
  expect(redactCredentialText(prefix + credential + suffix)).toBe(prefix + "[REDACTED]" + suffix)
  for (let split = 0; split <= credential.length; split++) {
    const first = prefix + credential.slice(0, split)
    expect(credentialTextMayContinue(first)).toBe(true)
    const state = pendingAuthorizationState(first)!
    const rest = credential.slice(split) + suffix
    if (state) expect(rest.slice(consumeAuthorization(rest, state))).toBe(suffix)
    else expect(redactCredentialText(first + rest)).toBe(prefix + "[REDACTED]" + suffix)
  }
})

it("retains an incomplete custom authorization scheme", () => {
  expect(credentialTextMayContinue("Authorization: Custom-Au")).toBe(true)
  expect(pendingCredentialTextSuffix("prefix Authorization: Custom-Au")).toBe("Authorization: Custom-Au")
  expect(redactCredentialText("Use token examples and Digest prose")).toBe("Use token examples and Digest prose")
})


it.each(["|", ">-", "|+", "|2", ">2-", "|-2", "| # 9 is a comment"])("redacts YAML block scalar %s through its dedent", (indicator) => {
  const prefix = "config:\n  private_key: "
  const scalar = `${indicator}\n    -----BEGIN PRIVATE KEY-----\n    sensitive-value\n\n    -----END PRIVATE KEY-----`
  const suffix = "\n  status: ok\nnext: retained"
  expect(redactCredentialText(prefix + scalar + suffix)).toBe(prefix + "[REDACTED]" + suffix)
  for (let split = 0; split <= scalar.length; split++) {
    const first = prefix + scalar.slice(0, split)
    const state = pendingCredentialAssignmentState(first)
    expect(state, `split ${split}`).toBeDefined()
    const rest = scalar.slice(split) + suffix
    const boundary = consumeCredentialAssignment(rest, state!)
    expect(state!.yaml!.whitespace + rest.slice(boundary), `split ${split}`).toBe(suffix)
  }
})

it("retains YAML scalar redaction state across individual characters", () => {
  const state = pendingCredentialAssignmentState("api_token: ")!
  for (const character of ">-\n  sensitive-value\n\n  more-secret\n") {
    expect(consumeCredentialAssignment(character, state)).toBe(1)
  }
  expect(consumeCredentialAssignment("status: ok", state)).toBe(0)
  expect(state.yaml?.whitespace).toBe("\n")
})

it("uses preceding indentation for a retained YAML key", () => {
  expect(redactCredentialText("api_token: |\n    secret\n  status: ok", "  "))
    .toBe("api_token: [REDACTED]\n  status: ok")
})

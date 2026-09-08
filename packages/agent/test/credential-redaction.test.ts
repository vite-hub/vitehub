import { describe, expect, it } from "vitest"
import { credentialTextMayContinue, pendingCredentialAssignment, pendingCredentialQuote, pendingCredentialScheme, pendingCredentialTextSuffix, redactCredentialText } from "../src/internal/credential-redaction.ts"

describe("structured credential redaction", () => {
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

it.each(["Authorization: Basic", "Basic", "Bearer", "bearer", "BEARER"])("keeps credential redaction for %s", (scheme) => {
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

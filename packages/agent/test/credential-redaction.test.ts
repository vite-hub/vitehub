import { describe, expect, it } from "vitest"
import { consumeAuthorization, consumeCredentialAssignment, credentialTextLineContext, credentialTextMayContinue, pendingAuthorizationState, pendingCredentialAssignment, pendingCredentialAssignmentState, pendingCredentialQuote, pendingCredentialScheme, pendingCredentialTextSuffix, redactCredentialText } from "../src/internal/credential-redaction.ts"

it("bounds structured credential state across an unclosed stream", () => {
  const state = pendingCredentialAssignmentState("PASSWORD={")!
  for (let chunk = 0; chunk < 128; chunk++) {
    expect(consumeCredentialAssignment("{[".repeat(1024), state)).toBe(2048)
    expect(state.structureClosers!.length).toBeLessThanOrEqual(128)
  }
  const tail = '}]'.repeat(1024) + " private-value;status=ok"
  expect(consumeCredentialAssignment(tail, state)).toBe(tail.length)
  expect(redactCredentialText("PASSWORD=" + "{".repeat(129) + tail)).toBe("PASSWORD=[REDACTED]")
})

it("preserves the suffix after a structured credential within the nesting limit", () => {
  const value = "{[".repeat(64) + '"private"' + "]}".repeat(64)
  expect(redactCredentialText("PASSWORD=" + value + ";status=ok")).toBe("PASSWORD=[REDACTED];status=ok")
  const state = pendingCredentialAssignmentState("PASSWORD=" + value.slice(0, 128))!
  const rest = value.slice(128) + ";status=ok"
  expect(rest.slice(consumeCredentialAssignment(rest, state))).toBe(";status=ok")
})

it.each([
  ["{password: ", "}"],
  ["config: {password: ", ", status: ok}"],
  ["{status: ok, secret: ", "}"],
])("redacts YAML flow mapping values after %s", (prefix, suffix) => {
  expect(redactCredentialText(prefix + "sensitive value" + suffix)).toBe(prefix + "[REDACTED]" + suffix)
  const keyStart = prefix.search(/(?:password|secret):/)
  const context = credentialTextLineContext(prefix.slice(0, keyStart))
  const assignment = prefix.slice(keyStart)
  expect(redactCredentialText(assignment + "sensitive value" + suffix, context)).toBe(assignment + "[REDACTED]" + suffix)
  for (let split = 0; split <= "sensitive value".length; split++) {
    const state = pendingCredentialAssignmentState(assignment + "sensitive value".slice(0, split), context)!
    expect(state).toBeDefined()
    const rest = "sensitive value".slice(split) + suffix
    expect(rest.slice(consumeCredentialAssignment(rest, state))).toBe(suffix)
  }
})

it.each([
  ["", "|", "  ", ""],
  ["", ">", "  ", ""],
  ["", "|-", "  ", ""],
  ["", ">+", "  ", ""],
  ["", "|2", "  ", ""],
  ["config:\n  ", "|", "    ", "  "],
  ["- ", "|2", "    ", "  "],
])("preserves field-like prose inside YAML %s%s scalars", (prefix, style, indent, siblingIndent) => {
  const prose = `${prefix}message: ${style}\n${indent}password: "ordinary words"\n${indent}secret: ordinary text\n`
  const input = prose + `${siblingIndent}password: sensitive-value\n${siblingIndent}status: ok`
  const expected = prose + `${siblingIndent}password: [REDACTED]\n${siblingIndent}status: ok`
  expect(redactCredentialText(input)).toBe(expected)
  for (let split = 0; split <= prose.length; split++) {
    let context = ""
    for (const character of input.slice(0, split)) context = credentialTextLineContext(context + character)
    expect(redactCredentialText(input.slice(split), context)).toBe(expected.slice(split))
  }
})

it.each(["\r", "\n", "\r\n"])("preserves YAML siblings after %j line breaks", (lineBreak) => {
  for (const scalar of ["sensitive value", `|${lineBreak}    sensitive value`, `>${lineBreak}    sensitive value`]) {
    const prefix = `config:${lineBreak}  password: `
    const suffix = `${lineBreak}  status: ok`
    expect(redactCredentialText(prefix + scalar + suffix)).toBe(prefix + "[REDACTED]" + suffix)
    const captured = scalar + suffix
    for (let split = 1; split <= scalar.length; split++) {
      const state = pendingCredentialAssignmentState(prefix + captured.slice(0, split))!
      const rest = captured.slice(split)
      const boundary = consumeCredentialAssignment(rest, state)
      expect(state.yaml!.whitespace + rest.slice(boundary)).toBe(suffix)
    }
    const state = pendingCredentialAssignmentState(prefix + scalar)!
    for (const character of lineBreak + "  ") expect(consumeCredentialAssignment(character, state)).toBe(1)
    expect(consumeCredentialAssignment("status: ok", state)).toBe(0)
    expect(state.yaml!.whitespace + "status: ok").toBe(suffix)
  }
})

describe("plain YAML credential scalars", () => {
  it.each(["", "\n"])("bounds retained separators after a credential and %j", (lineBreak) => {
    const state = pendingCredentialAssignmentState("password: sensitive" + lineBreak)!
    for (let chunk = 0; chunk < 128; chunk++) {
      expect(consumeCredentialAssignment(" ".repeat(1024), state)).toBe(1024)
      expect(state.yaml!.whitespace.length).toBeLessThanOrEqual(1024)
    }
    expect(consumeCredentialAssignment("# public comment\nstatus: ok", state)).toBe(0)
    expect(state.yaml!.whitespace.length).toBeLessThanOrEqual(1024)
    expect(state.yaml!.whitespace.startsWith(lineBreak)).toBe(true)
  })

  it.each([
    ["password: ", "correct horse battery", "\nstatus: ok"],
    ["api_token: ", "sensitive value", " # public comment\nstatus: ok"],
    ["config:\n  password: ", "correct horse\n    battery\n\n   staple", "\n  status: ok"],
    ["  - secret: ", "sensitive value\n      more secret", "\n    status: ok"],
    ["password: ", 'sensitive#value,with;shell&punctuation<> and "quotes"', "\nstatus: ok"],
    ["password: ", "correct horse\n  battery", "  # public comment\nstatus: ok"],
  ])("redacts all words in %s across every split", (prefix, scalar, suffix) => {
    expect(redactCredentialText(prefix + scalar + suffix)).toBe(prefix + "[REDACTED]" + suffix)
    for (let split = 0; split <= scalar.length; split++) {
      const state = pendingCredentialAssignmentState(prefix + scalar.slice(0, split))!
      expect(state, `split ${split}`).toBeDefined()
      const rest = scalar.slice(split) + suffix
      const boundary = consumeCredentialAssignment(rest, state)
      expect(state.yaml!.whitespace + rest.slice(boundary), `split ${split}`).toBe(suffix)
    }
  })

  it("retains plain scalar and comment boundaries across individual characters", () => {
    const state = pendingCredentialAssignmentState("password: ")!
    for (const character of "correct horse\n  battery \t") {
      expect(consumeCredentialAssignment(character, state)).toBe(1)
    }
    expect(consumeCredentialAssignment("# public comment", state)).toBe(0)
    expect(state.yaml!.whitespace).toBe(" \t")
  })
})

describe("structured credential redaction", () => {
  it.each([
    "(first-secret second-secret)",
    "('first ) secret' \"second secret\")",
    "(first\\)secret second-secret)",
    '("$(printf \'%s\' "nested secret")" last-secret)',
    "($(printf '%s' nested-secret) last-secret)",
    "(<(printf '%s' nested-secret) last-secret)",
  ])("redacts complete shell credential arrays: %s", (credential) => {
    const prefix = "PASSWORD="
    const suffix = "; status=ok"
    expect(redactCredentialText(prefix + credential + suffix)).toBe(prefix + "[REDACTED]" + suffix)
    for (let split = 0; split <= credential.length; split++) {
      const state = pendingCredentialAssignmentState(prefix + credential.slice(0, split))!
      expect(state, `split ${split}`).toBeDefined()
      const remainder = credential.slice(split) + suffix
      expect(remainder.slice(consumeCredentialAssignment(remainder, state)), `split ${split}`).toBe(suffix)
    }
    expect(redactCredentialText("VALUES=" + credential + suffix)).toBe("VALUES=" + credential + suffix)
  })

  it.each([
    '{"d":"sensitive"}',
    '["first-secret","second-secret"]',
    '[{"d":"sensitive"},["other-secret"]]',
    '{]"d":"sensitive"}',
    '[}"sensitive"]',
    '{"nested":[{"d":"escaped\\\"} ] secret"},["other-secret"]]}',
  ])("redacts complete structured credential values: %s", (credential) => {
    const prefix = '{"privateKey":'
    const suffix = ',"status":"ok"}'
    expect(redactCredentialText(prefix + credential + suffix)).toBe(prefix + "[REDACTED]" + suffix)
    // Every possible split must preserve the same end boundary, including splits
    // inside an escaped quote and immediately after the final closing delimiter.
    for (let split = 0; split <= credential.length; split++) {
      const state = pendingCredentialAssignmentState(prefix + credential.slice(0, split))!
      expect(state, `split ${split}`).toBeDefined()
      const remainder = credential.slice(split) + suffix
      const boundary = consumeCredentialAssignment(remainder, state)
      expect(remainder.slice(boundary), `split ${split}`).toBe(suffix)
    }
    expect(redactCredentialText('{"payload":' + credential + suffix)).toBe('{"payload":' + credential + suffix)
  })

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

it.each(["API_TOKEN ?", "PASSWORD +", "--api-token?", "'PASSWORD' +"])("retains partial compound assignment %s across flushes", (prefix) => {
  expect(credentialTextMayContinue(prefix)).toBe(true)
  expect(pendingCredentialTextSuffix(prefix)).toBe(prefix)
  expect(redactCredentialText(prefix)).toBe(prefix)
  expect(redactCredentialText(prefix + "= sensitive-value;status=ok")).toBe(prefix + "= [REDACTED];status=ok")
  const state = pendingCredentialAssignmentState(prefix + "= ")!
  expect(state).toBeDefined()
  const rest = "sensitive-value;status=ok"
  expect(rest.slice(consumeCredentialAssignment(rest, state))).toBe(";status=ok")
})

it.each(["status +", "ordinary ?"])("preserves non-credential partial operator %s", (text) => {
  expect(credentialTextMayContinue(text)).toBe(false)
  expect(pendingCredentialTextSuffix(text)).toBeUndefined()
  expect(redactCredentialText(text + "= public")).toBe(text + "= public")
})

it.each(["API_TOKEN ?= sensitive", "PASSWORD += secret", "PASSWORD := value"]) ("redacts compound assignments", (input) => {
  expect(redactCredentialText(input)).toMatch(/\[REDACTED\]/)
})

it.each([
  "machine example.com login alice ",
  "machine example.com ",
  "machine example.com account billing login alice ",
  "machine example.com login alice account billing ",
  "machine example.com\n  account billing\n  ",
  "default ",
  "default login alice ",
  "default account billing login alice ",
  'machine example.com login "Alice Smith" account billing ',
])("redacts whitespace-delimited netrc passwords after %s", (context) => {
  const suffix = " login next-user\nmachine next.example"
  expect(redactCredentialText(context + "password sensitive-value" + suffix)).toBe(context + "password [REDACTED]" + suffix)
  expect(redactCredentialText("password sensitive-value" + suffix, credentialTextLineContext(context))).toBe("password [REDACTED]" + suffix)
  for (let split = 0; split <= "sensitive-value".length; split++) {
    const state = pendingCredentialAssignmentState("password " + "sensitive-value".slice(0, split), context)!
    expect(state).toBeDefined()
    const rest = "sensitive-value".slice(split) + "\nmachine next.example"
    expect(rest.slice(consumeCredentialAssignment(rest, state))).toBe("\nmachine next.example")
  }
  expect(redactCredentialText("Choose a password with several words")).toBe("Choose a password with several words")
})

it.each([
  "The machine needs a password with several words",
  "Use the default password with several words",
  "machine example.com documentation mentions password requirements",
])("preserves non-netrc password prose: %s", (text) => {
  expect(redactCredentialText(text)).toBe(text)
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
  ["api_token: sensitive-value;status=ok", "api_token: [REDACTED]"],
  ["api_token: sensitive-value\nstatus: ok", "api_token: [REDACTED]\nstatus: ok"],
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
  expect(redactCredentialText(`${key}: sensitive-value;status=ok`)).toBe(`${key}: [REDACTED]`)
  expect(redactCredentialText(`${key}: sensitive-value\nstatus: ok`)).toBe(`${key}: [REDACTED]\nstatus: ok`)
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

it.each([".".repeat(512), "diagnostic...", "status=ok;", "prefix-"])("preserves authorization boundaries after %s", (prefix) => {
  const context = credentialTextLineContext(prefix)
  for (const scheme of ["basic", "BASIC", "bearer", "BEARER"]) {
    const header = `Authorization: ${scheme} `
    expect(redactCredentialText(`${header}sensitive-value;status=ok`, context)).toBe(`${header}[REDACTED];status=ok`)
    expect(pendingCredentialScheme(header, context)).toBe("scheme")
  }
})

it.each([
  ["PASSWORD=$(printf supersecret);status=ok", "PASSWORD=[REDACTED];status=ok"],
  ["PASSWORD=${UNSET:-sensitive-value};status=ok", "PASSWORD=[REDACTED];status=ok"],
  ["PASSWORD=${UNSET:-${OTHER:-secret words}}tail;status=ok", "PASSWORD=[REDACTED];status=ok"],
  ["PASSWORD=${UNSET:-$(printf 'secret words')};status=ok", "PASSWORD=[REDACTED];status=ok"],
  ["PASSWORD=<(printf sensitive-value);status=ok", "PASSWORD=[REDACTED];status=ok"],
  ["PASSWORD=>(cat sensitive-file);status=ok", "PASSWORD=[REDACTED];status=ok"],
  ["PASSWORD=<(printf $(printf 'secret) words'))tail;status=ok", "PASSWORD=[REDACTED];status=ok"],
  ["PASSWORD=$(cat <(printf secret));status=ok", "PASSWORD=[REDACTED];status=ok"],
  ["PASSWORD=`printf supersecret`;status=ok", "PASSWORD=[REDACTED];status=ok"],
  ['PASSWORD="$(printf "secret words")";status=ok', 'PASSWORD="[REDACTED]";status=ok'],
  ["PASSWORD=$(printf $(printf supersecret))tail;status=ok", "PASSWORD=[REDACTED];status=ok"],
  ["PASSWORD=$((1 + 2));status=ok", "PASSWORD=[REDACTED];status=ok"],
  ["PASSWORD=$(printf 'secret) words');status=ok", "PASSWORD=[REDACTED];status=ok"],
  ["PASSWORD=$(printf `printf supersecret`);status=ok", "PASSWORD=[REDACTED];status=ok"],
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
  ['{"authorization":"', "abc;def&ghi<jkl>mno}pqr", '", "status":"ok"}'],
  ['{"authorization":"', "Custom-Auth abc;def", '", "status":"ok"}'],
  ['{"authorization":"', "abc'def;ghi", '", "status":"ok"}'],
  ['{"authorization":"', String.raw`abc\"def;ghi`, '", "status":"ok"}'],
  ["Authorization: '", 'abc"def;ghi', "';status=ok"],
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


it.each(["private_key", "password", "secret"].flatMap(key => ["|", ">-", "|+", "|2", ">2-", "|-2", "| # 9 is a comment", "&credential |", "!!str >-", "&credential !!str |2-", "!<tag:yaml.org,2002:str> &credential >"].map(indicator => ({ key, indicator }))))("redacts YAML $key block scalar $indicator through its dedent", ({ key, indicator }) => {
  const prefix = `config:\n  ${key}: `
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


it.each(["password", "secret"])("redacts bare YAML %s fields with retained line context", (key) => {
  for (const preceding of ["", "  ", "config:\n  ", "  - "]) {
    const value = `${key}: "correct horse"\nstatus: ok`
    expect(redactCredentialText(preceding + value)).toBe(`${preceding}${key}: "[REDACTED]"\nstatus: ok`)
    expect(redactCredentialText(value, preceding)).toBe(`${key}: "[REDACTED]"\nstatus: ok`)
    expect(pendingCredentialQuote(`${key}: "correct`, preceding)).toBe('"')
    expect(credentialTextMayContinue(`${key}: correct`, preceding)).toBe(true)
    expect(pendingCredentialAssignmentState(`${key}: |`, preceding)?.yaml).toBeDefined()
  }
  const prose = `Field label. ${key}: "ordinary words"`
  expect(redactCredentialText(prose)).toBe(prose)
  expect(pendingCredentialQuote(`${key}: "ordinary`, "Field label. ")).toBeUndefined()
  expect(credentialTextMayContinue(`${key}: ordinary`, "Field label. ")).toBe(false)
})

describe("credential line context across journal chunks", () => {
  it.each(["- ", "  - ", "  -   "])("preserves YAML list prefix %j", (prefix) => {
    const context = credentialTextLineContext(`config:\n${prefix}`)
    for (const key of ["password", "secret"]) {
      const value = `${key}: "sensitive-value"\n    status: ok\n`
      expect(redactCredentialText(value, context)).toBe(`${key}: "[REDACTED]"\n    status: ok\n`)
      expect(pendingCredentialAssignmentState(`${key}: "sensitive`, context)?.quote).toBe('"')
    }
  })

  it("preserves inline prose and drops previous values from context", () => {
    const context = credentialTextLineContext("A list - ")
    expect(context).toBe("x ")
    expect(redactCredentialText('password: "ordinary words"', context)).toBe('password: "ordinary words"')
    expect(credentialTextLineContext('password: "sensitive-value"')).toBe("x ")
  })
})


it.each([
  "password:\nstatus: ok",
  "password: \nstatus: ok",
  "password: # optional\nstatus: ok",
  "config:\n  secret: \r\n  status: ok",
])("preserves empty YAML credential values: %s", (text) => {
  expect(redactCredentialText(text)).toBe(text)
})


it.each(["_authToken", "_password", "_auth", "auth", "__APIKEY"])("redacts npm credential key %s across chunk boundaries", (key) => {
  const prefix = `//registry.npmjs.org/:${key}=`
  const secret = "c2VjcmV0=="
  expect(redactCredentialText(`${prefix}${secret};status=ok`)).toBe(`${prefix}[REDACTED];status=ok`)
  for (let split = 1; split <= key.length; split++) {
    const partial = key.slice(0, split)
    expect(credentialTextMayContinue(partial)).toBe(true)
    expect(pendingCredentialTextSuffix(partial)).toBe(partial)
    expect(redactCredentialText(`${partial}${key.slice(split)}=${secret}`)).toBe(`${key}=[REDACTED]`)
  }
  for (let split = 0; split <= secret.length; split++) {
    const state = pendingCredentialAssignmentState(prefix + secret.slice(0, split))!
    expect(state).toBeDefined()
    const rest = secret.slice(split) + ";status=ok"
    expect(rest.slice(consumeCredentialAssignment(rest, state))).toBe(";status=ok")
  }
})

it.each(["auth is configured", "authorization is required", "oauth=enabled", "author=alice"])("preserves non-credential auth text: %s", (text) => {
  expect(redactCredentialText(text)).toBe(text)
})

describe("passphrase credentials", () => {
  it.each(["SSH_KEY_PASSPHRASE", "KEYSTORE_PASSPHRASE", "passphrase", "sshPassphrase", "ssh-passphrase"])("redacts %s and retains split key prefixes", (key) => {
    expect(redactCredentialText(`${key}=sensitive-value;status=ok`)).toBe(`${key}=[REDACTED];status=ok`)
    expect(redactCredentialText(`${key}="correct horse";status=ok`)).toBe(`${key}="[REDACTED]";status=ok`)
    for (let split = key.toLowerCase().indexOf("passphrase") + 1; split <= key.length; split++) {
      const prefix = key.slice(0, split)
      expect(credentialTextMayContinue(`${".".repeat(512)}${prefix}`), prefix).toBe(true)
      expect(pendingCredentialTextSuffix(`${".".repeat(512)}${prefix}`)).toBe(prefix)
    }
  })

  it.each(["SSH_KEY_PASSPHRASE=", "KEYSTORE_PASSPHRASE=", "--passphrase ", "--passphrase="])("redacts %s values across every split", (prefix) => {
    for (const secret of ["sensitive-value", '"correct horse"']) {
      const suffix = ";status=ok"
      expect(redactCredentialText(prefix + secret + suffix)).toBe(prefix + (secret.startsWith('"') ? '"[REDACTED]"' : "[REDACTED]") + suffix)
      for (let split = 0; split < secret.length; split++) {
        const first = prefix + secret.slice(0, split)
        expect(credentialTextMayContinue(first)).toBe(true)
        const state = pendingCredentialAssignmentState(first)!
        expect(state).toBeDefined()
        const rest = secret.slice(split) + suffix
        expect(rest.slice(consumeCredentialAssignment(rest, state))).toBe(suffix)
      }
    }
  })

  it.each(["passphrase authentication is configured", "bypassphrase=public", "passphrase_hint=public"])("preserves non-credential text %s", (value) => {
    expect(redactCredentialText(value)).toBe(value)
  })
})


it.each(["<", ">"])("preserves ordinary text after a split shell marker %s", (marker) => {
  const state = pendingCredentialAssignmentState(`PASSWORD=private${marker}`)!
  expect(consumeCredentialAssignment("", state)).toBe(0)
  const rest = "public-file;status=ok"
  expect(consumeCredentialAssignment(rest, state)).toBe(0)
  expect(state.shellProcess).toBe(marker)
  expect(redactCredentialText(`PASSWORD=private${marker}${rest}`)).toBe(`PASSWORD=[REDACTED]${marker}${rest}`)
})

it.each(["<", ">"])("keeps split redirects inside shell substitutions secret: %s", (marker) => {
  const state = pendingCredentialAssignmentState(`PASSWORD=$(cat ${marker}`)!
  const rest = "private-file);status=ok"
  expect(rest.slice(consumeCredentialAssignment(rest, state))).toBe(";status=ok")
  expect(state.shellProcess).toBeUndefined()
})

import { ViteHubError } from "../errors.ts"
import { isRuntimeObject } from "./runtime-type.ts"

declare const grantKind: unique symbol

/**
 * Proof that one check passed. Only the definition that issued it can verify it.
 * The `Kind` brand is type-only. It keeps grants of different definitions apart at type level.
 */
export interface Grant<Kind extends string> {
  readonly [grantKind]: Kind
}

export interface GrantDefinition<Kind extends string, Input, Value> {
  readonly kind: Kind
  /** Issue a frozen grant bound to `bind(input)`. `fields` become public read-only fields of the grant. */
  issue: {
    (input: Input): Grant<Kind>
    <Fields extends object>(input: Input, fields: Fields): Grant<Kind> & Readonly<Fields>
  }
  /** Return the bound value, or `undefined` for a forged, consumed, or foreign value. Never throws. */
  check: (candidate: unknown) => Value | undefined
  /** Return whether this definition issued the candidate and it has not been consumed. Never throws. */
  isValid: (candidate: unknown) => boolean
  /** Return the bound value. Throws `GRANT_REQUIRED` when this definition did not issue the grant, or it was consumed. */
  verify: (grant: Grant<Kind>) => Value
  /** Verify the grant and revoke it, so it works only once. */
  consume: (grant: Grant<Kind>) => Value
  /** Attach a valid grant to an owner object, for example a request or a context. */
  attach: (owner: WeakKey, grant: Grant<Kind>) => void
  /** Return the grant attached to `owner`, or `undefined` when there is none or it was consumed. */
  attached: (owner: WeakKey) => Grant<Kind> | undefined
}

/**
 * Define one kind of grant. Keep the definition module-private: the module that owns the check issues grants,
 * and the sensitive action verifies them. Each definition has its own registry, so a grant from another definition,
 * another bundled copy, or a forged object fails closed. Grants are request-scoped. Never persist one.
 */
// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- The parameter type of `bind` supplies `Input`.
export function defineGrant<const Kind extends string, Input, Value>(
  kind: Kind,
  bind: (input: Input) => Value,
): GrantDefinition<Kind, Input, Value> {
  // Boxed, so a bound `undefined` still counts as issued.
  const issued = new WeakMap<object, { readonly value: Value }>()
  const owners = new WeakMap<WeakKey, Grant<Kind>>()

  function issue(input: Input): Grant<Kind>
  function issue<Fields extends object>(input: Input, fields: Fields): Grant<Kind> & Readonly<Fields>
  function issue<Fields extends object>(input: Input, fields?: Fields): Grant<Kind> {
    const grant = Object.freeze({ ...fields })
    issued.set(grant, Object.freeze({ value: bind(input) }))
    // SAFETY: The brand is type-only. The `issued` entry above is the runtime proof that `verify()` checks.
    return grant as Grant<Kind>
  }

  function verify(grant: Grant<Kind>): Value {
    const entry = issued.get(grant)
    if (!entry) throw new ViteHubError("GRANT_REQUIRED", `[vitehub] This action requires a valid "${kind}" grant.`, { details: { kind } })
    return entry.value
  }

  const definition: GrantDefinition<Kind, Input, Value> = {
    kind,
    issue,
    check: candidate => isRuntimeObject(candidate) ? issued.get(candidate)?.value : undefined,
    verify,
    consume: (grant) => {
      const value = verify(grant)
      issued.delete(grant)
      return value
    },
    isValid: candidate => isRuntimeObject(candidate) && issued.has(candidate),
    attach: (owner, grant) => {
      verify(grant)
      owners.set(owner, grant)
    },
    attached: (owner) => {
      const grant = owners.get(owner)
      return grant && issued.has(grant) ? grant : undefined
    },
  }
  return Object.freeze(definition)
}

/**
 * `{{NAME}}` in a connection's own fields, resolved from the globals file.
 *
 * One connection per site, all identical apart from a jump host and a bastion
 * account, is the case this exists for: the fields hold `{{SITE_CORE}}` and
 * `{{BASTION_USER}}`, and the globals file says which site you are working on
 * today.
 *
 * Two deliberate limits:
 *
 *  - **Globals only — no built-ins.** `{{DATE}}` in a connection name would be
 *    harmless, but the same rule would put `{{RANDOM}}` in a hostname, and
 *    `{{SESSION_HOST}}` is circular here by definition — it is derived from the
 *    very field being resolved. One rule that is always true ("these boxes read
 *    your globals file") beats a list of exceptions.
 *
 *  - **An unresolved name is an error, not a literal.** `interpolate()` leaves
 *    `{{TYPO}}` in place, which is right for a button's text and wrong for
 *    everything here: an unresolved host becomes a DNS failure that names a
 *    host you never typed, and an unresolved *password* is sent to the remote
 *    as the literal string `{{TYPO}}` — a failed authentication that looks
 *    exactly like a wrong password, against an account that may lock out. So
 *    the connection is refused before a packet is sent, naming the variable.
 */

import { referencedNames } from './global-vars'
import { interpolate } from './types'

/** Which boxes on the connection form read the globals file. */
export const PROFILE_VAR_FIELDS = ['name', 'host', 'username', 'password'] as const

export type ProfileVarField = (typeof PROFILE_VAR_FIELDS)[number]

/** How a field's label reads in an error message. */
const FIELD_LABELS: Record<ProfileVarField, string> = {
  name: 'Name',
  host: 'Host',
  username: 'Username',
  password: 'Password',
}

export interface FieldVarStatus {
  /** Names the field refers to, in order of first appearance. */
  names: string[]
  /** Of those, the ones the globals file does not define. */
  missing: string[]
}

/** What a single field refers to and whether the globals file can supply it. */
export function inspectProfileField(
  raw: string,
  globals: Record<string, string>
): FieldVarStatus {
  const names = referencedNames(raw ?? '')
  return {
    names,
    missing: names.filter(
      (name) => !Object.prototype.hasOwnProperty.call(globals, name)
    ),
  }
}

/**
 * Substitutes one field, or throws naming the variable and the box it is in.
 *
 * `field` is passed for the message alone. Being told "Host refers to
 * {{SITE_CORE}}" is the difference between a one-line fix and reading the
 * globals file next to the connection form.
 */
export function resolveProfileField(
  field: ProfileVarField,
  raw: string,
  globals: Record<string, string>
): string {
  const text = raw ?? ''
  const { missing } = inspectProfileField(text, globals)

  if (missing.length > 0) {
    const list = missing.map((name) => `{{${name}}}`).join(', ')
    throw new Error(
      `${FIELD_LABELS[field]} refers to ${list}, which ${
        missing.length === 1 ? 'is' : 'are'
      } not set in your global variables file. Add ${
        missing.length === 1 ? 'it' : 'them'
      } there, or edit the connection.`
    )
  }

  return interpolate(text, globals)
}

/**
 * The subset of a connection this module touches.
 *
 * Structurally typed rather than importing `Profile`, so the main process can
 * hand it a whole profile and the connection form can hand it a draft that is
 * not a valid profile yet.
 */
export interface ProfileVarFields {
  name: string
  host: string
  username: string
}

/**
 * Returns `profile` with its variable-bearing fields substituted.
 *
 * The password is not here: it never lives on the profile — it is in the OS
 * keychain — so it is resolved where it is read, at `buildConnectConfig`.
 */
export function resolveProfileVars<T extends ProfileVarFields>(
  profile: T,
  globals: Record<string, string>
): T {
  return {
    ...profile,
    name: resolveProfileField('name', profile.name, globals),
    host: resolveProfileField('host', profile.host, globals),
    username: resolveProfileField('username', profile.username, globals),
  }
}

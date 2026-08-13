/**
 * THE ASSISTANT PROPOSES. IT NEVER EXECUTES.
 * ==========================================
 *
 * This is a product promise, not an implementation detail. The panel reads the
 * operator's terminal — a live session on production network gear, a PBX at a
 * console prompt, a switch mid-boot — and answers questions about it. The
 * operator tolerates that access precisely because the assistant cannot act:
 * every command it suggests is run by a human who read it first.
 *
 * It has already been broken once. The Insert button used to `sendToSession`
 * the suggestion as *typing*, so a four-line answer ran line by line as it
 * arrived — in a panel whose stated contract is that it never runs anything.
 * That was a two-line change that looked like a convenience.
 *
 * So the invariant is enforced by tests that read the real source files
 * (`electron/ai/assistant-cannot-execute.test.ts`) and fail the build the
 * moment assistant code gains a way to make something happen. The lists below
 * are what those tests check against.
 *
 * ## If you are here because a test failed
 *
 * You added something to the assistant that can execute, or a new `ai:*` IPC
 * channel. Neither is a lint nit — it changes what the product promises the
 * people who point this at live equipment. Ways forward, in order of
 * preference:
 *
 *  1. Route the action through something the operator triggers: a button, or
 *     the Insert path, which puts text on the command line and stops there.
 *  2. If the product decision really has changed, change it deliberately:
 *     update this file, the panel's own wording, and the system prompt that
 *     tells the model it is read-only. All three, in the same commit.
 *
 * Do not delete the test, and do not add the identifier to the allow-list to
 * make the failure go away. The failure is the feature.
 */

/**
 * Every IPC channel the assistant subsystem is allowed to own.
 *
 * Deliberately none of them act on a session: they ask a question, cancel a
 * question, and manage settings and keys. A channel like `ai:run` or
 * `ai:apply-fix` belongs to a different product than this one.
 */
export const ASSISTANT_IPC_CHANNELS = Object.freeze([
  'ai:ask',
  'ai:cancel',
  'ai:get-settings',
  'ai:save-settings',
  'ai:set-key',
  'ai:key-status',
  'ai:list-models',
] as const)

/**
 * Identifiers and channel names that mean "this code can make something run".
 *
 * Matched as plain substrings against source with comments removed. Kept
 * specific on purpose: a false positive teaches people to route around the
 * check, which is worse than a gap.
 */
export const EXECUTION_CAPABLE_TOKENS = Object.freeze([
  // Writing to a live session
  'sendToSession',
  'sessions:send',
  'sessions:broadcast',
  'shell.write',
  // Running a stored script or button
  'runMacro',
  'macros:run',
  'scripts:run',
  'stageScript',
  'buildScriptCommand',
  // Running something on this machine
  'child_process',
  'execSync',
  'execFile',
  'spawnSync',
] as const)

/**
 * The one channel the assistant panel may use to put text in front of the
 * operator. It inserts onto the command line and never submits it — see
 * `SSHManager.insertSuggestion`.
 */
export const ASSISTANT_INSERT_CHANNEL = 'sessions:insert-suggestion'

/**
 * Strips comments so the invariant's own documentation does not trip the scan.
 *
 * Naive about `//` inside string literals, which is why URLs are not part of
 * what is searched for; the tokens above are all identifiers or channel names.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Execution-capable tokens present in `source`, ignoring comments. */
export function findExecutionCapability(source: string): string[] {
  const code = stripComments(source)
  return EXECUTION_CAPABLE_TOKENS.filter((token) => code.includes(token))
}

/** The `ai:*` channels a file declares, in the order they appear. */
export function declaredAiChannels(ipcSource: string): string[] {
  return [...stripComments(ipcSource).matchAll(/literal\('(ai:[a-z-]+)'\)/g)].map(
    (match) => match[1]
  )
}

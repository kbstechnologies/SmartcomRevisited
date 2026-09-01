/**
 * The bridge from tldr to the assistant that already exists.
 *
 * This deliberately produces *text*, not a second AI client. Ask AI from the
 * tldr panel writes a question and hands it to `AssistantPanel`, which sends it
 * through the same `ai:ask` as anything typed by hand — same provider, same
 * grounding, same streaming, same "it proposes, it never executes" contract.
 * See `src/shared/assistant-contract.ts` for why adding a second path would be
 * the wrong shape.
 *
 * What is *not* sent matters as much as what is. The question carries the
 * command, its platform and the name of the box — never terminal history,
 * never credentials. The command itself goes through the same redaction the
 * assistant applies to terminal output, because a command line is one of the
 * places a password most often ends up (`mysql -pHunter2`).
 */

import { redactSecrets } from './ai'

/**
 * Secrets that hide in *command-line shape* rather than in `key: value` shape.
 *
 * `redactSecrets` is tuned for terminal output, where secrets appear as
 * assignments and prompts. A command line puts them in flags instead, and
 * `snmpwalk -c s3cr3t` looks nothing like anything that pattern set matches.
 * Kept here rather than added to the shared list because the shared list also
 * runs over screen output, where `-c` means a dozen harmless things and
 * over-redaction would blind the assistant to what it is looking at.
 */
const COMMAND_LINE_SECRETS: RegExp[] = [
  // --password=x, --token x, -password x
  /(-{1,2}(?:password|passwd|pass|secret|token|api[-_]?key)[=\s]+)\S+/gi,
  // mysql -pHunter2 — no space, which is what makes it easy to miss
  /(\bmysql(?:dump|admin)?\b[^|;]*\s-p)[^\s-]\S*/gi,
  // SNMP community strings
  /(\bsnmp(?:walk|get|getnext|bulkwalk|bulkget|set|table|df|status|net)\b[^|;]*\s-c\s+)\S+/gi,
  // sshpass -p hunter2
  /(\bsshpass\b[^|;]*\s-p\s*)\S+/gi,
  // curl -u user:password
  /(\s-{1,2}u(?:ser)?\s+[^\s:]+:)\S+/g,
]

function redactCommandSecrets(command: string): string {
  let output = redactSecrets(command)
  for (const pattern of COMMAND_LINE_SECRETS) {
    output = output.replace(pattern, '$1[REDACTED SECRET]')
  }
  return output
}

export interface TldrAiContext {
  /** The command as it would be run, placeholders already filled in. */
  command: string
  /** The executable, after wrappers were stepped over. */
  baseCommand: string
  /** tldr platform the page came from, or the session's. */
  platform: string
  /** ssh / serial / local, when a session is in focus. */
  sessionType?: string
  /** How the operator names the box — the connection name. */
  targetName?: string
  /** The tldr page this came from, when it came from one. */
  tldrPage?: string
  /** The example's description, when one example was the starting point. */
  tldrExample?: string
}

/**
 * The structured payload, for logging and for anything that later wants the
 * context rather than the prose. Mirrors the fields above with the command
 * redacted, so this object is safe to write to a log.
 */
export function tldrAiPayload(context: TldrAiContext): Record<string, string> {
  const payload: Record<string, string> = {
    source: 'tldr',
    command: redactCommandSecrets(context.command),
    base_command: context.baseCommand,
    platform: context.platform,
  }
  if (context.sessionType) payload.session_type = context.sessionType
  if (context.targetName) payload.target = context.targetName
  if (context.tldrPage) payload.tldr_page = context.tldrPage
  if (context.tldrExample) payload.tldr_example = context.tldrExample
  return payload
}

/**
 * The question the assistant is actually asked.
 *
 * Written as prose rather than as a JSON blob because the receiving end is a
 * chat model reading a conversation the operator can also read: a question they
 * can see, edit and follow up on is worth more than a machine-shaped payload
 * they cannot.
 */
export function buildTldrAiPrompt(context: TldrAiContext): string {
  const command = redactCommandSecrets(context.command).trim()

  const facts: string[] = [`Platform: ${context.platform}`]
  if (context.targetName) {
    facts.push(`Target session: ${context.targetName}${context.sessionType ? ` (${context.sessionType})` : ''}`)
  }
  if (context.tldrPage) facts.push(`tldr page: ${context.tldrPage}`)
  if (context.tldrExample) facts.push(`tldr example: ${context.tldrExample}`)

  return [
    'Explain this command in more detail:',
    '',
    '```',
    command,
    '```',
    '',
    facts.join('\n'),
    '',
    'Please cover:',
    '- what each option means',
    '- what the command will actually do here',
    '- any risks, especially anything irreversible',
    '- common variations worth knowing',
    '- what output I should expect',
  ].join('\n')
}

import type { Bundle, Persona } from "./bundle.ts"

export const ORCHESTRATOR = "egm"

export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

export interface AgentDefinition {
  readonly id: string
  readonly description: string
  readonly mode: "primary" | "subagent"
  readonly color: string
  readonly system: string
  readonly permissions: readonly Rule[]
}

const rule = (action: string, resource: string, effect: Rule["effect"]): Rule => ({ action, resource, effect })

/** Directory boundary pattern; `*` spans `/` in V2 permission matching. */
const within = (directory: string) => `${directory}/*`

export function context(bundle: Bundle): string {
  return [
    `EGM bundle root: ${bundle.root}.`,
    "Resolve agents/, resources/, and docs/ against this root.",
    "Resolve references/ against the canonical skill directory.",
    "Resolve user files and outputs against the project working directory.",
    "Never substitute project files for bundled personas.",
    "This host is OpenCode V2: ignore Codex, Claude Code, and Cowork integration notes in the skills.",
  ].join(" ")
}

export function reviewer(bundle: Bundle, persona: Persona): AgentDefinition {
  return {
    id: persona.id,
    description: `EGM read-only ${persona.file} reviewer (experimental)`,
    mode: "subagent",
    color: "#E86E00",
    system: [
      context(bundle),
      `Read ${persona.path} before the target and supplied standards.`,
      "Return findings to the caller. Do not write reports or delegate.",
      "Read prior reports only when explicitly supplied and required by the canonical stage.",
      "Do not retrieve unsolicited history, memory, or earlier reviewer findings.",
      "Report inaccessible required files as an incomplete review.",
    ].join(" "),
    permissions: [
      rule("*", "*", "deny"),
      rule("read", "*", "allow"),
      // Restate the default .env rules: the broad allow above would otherwise win.
      rule("read", "*.env", "deny"),
      rule("read", "*.env.*", "deny"),
      rule("read", "*.env.example", "allow"),
      rule("glob", "*", "allow"),
      // grep searches file contents without applying per-file read rules, so it could expose .env files.
      rule("grep", "*", "deny"),
      rule("external_directory", "*", "deny"),
      rule("external_directory", within(bundle.root), "allow"),
    ],
  }
}

export function orchestrator(bundle: Bundle): AgentDefinition {
  const roster = bundle.personas.map((persona) => `- ${persona.id}: ${persona.path}`).join("\n")
  return {
    id: ORCHESTRATOR,
    description: "EGM orchestrator (experimental OpenCode V2)",
    mode: "primary",
    color: "#1B6EF3",
    system: [
      context(bundle),
      "",
      "Follow the canonical skill. Dispatch reviewers directly with the `subagent` tool:",
      "set `agent` to the registered persona name and supply `description` and `prompt`.",
      "Omit `sessionID` for every independent review so each reviewer starts in a fresh child session; never continue a reviewer.",
      "Omit `background` and wait for foreground completion.",
      "Pass only the task and absolute paths for the persona, target, standards, and selected reading list.",
      "Do not pass conversation history, private reasoning, or memory.",
      "Supply prior report paths only when the canonical stage requires them.",
      "",
      "Registered reviewers and their personas:",
      roster,
      "",
      "No synthesizer, bootstrap orchestrator, worker, or scout agent is installed. Perform synthesis and write reports yourself.",
      "Stop if a skill requires an unavailable agent; do not substitute a reviewer or simulate the missing worker.",
      "Never simulate Goldfish reviewers in this conversation.",
      "Require every specified read and actual reviewer completion before synthesis.",
      "Report a missing start, completion, required read, or malformed result as incomplete, and stop if delegation is unavailable.",
      "When running brainstorm before draft, complete all six brainstorm reviewers and synthesize their findings into concepts_brief.md before drafting.",
      "In review, write each completed stage report before starting the next stage.",
      "Before Step 8 (Intermediate Zoom Out), verify zoom_out_report.md exists in the artifact directory and pass its absolute path to the reviewer; stop if it is missing.",
      "Honor `EGM artifact directory: <path>` in the user's prompt or loaded instructions, resolving a relative path against the project directory.",
      "Otherwise retain the canonical output filenames and working-directory default.",
      "Preserve every readiness, section, and stage approval gate. Use the question tool, or ask one plain-text question, and wait for the answer.",
      "Missing tools and elapsed time do not constitute approval.",
    ].join("\n"),
    permissions: [
      rule("*", "*", "ask"),
      rule("read", "*", "allow"),
      rule("read", "*.env", "ask"),
      rule("read", "*.env.*", "ask"),
      rule("read", "*.env.example", "allow"),
      rule("glob", "*", "allow"),
      rule("grep", "*", "allow"),
      rule("question", "*", "allow"),
      rule("skill", "*", "deny"),
      ...bundle.skills.map((skill) => rule("skill", skill.id, "allow")),
      rule("subagent", "*", "deny"),
      ...bundle.personas.map((persona) => rule("subagent", persona.id, "allow")),
      rule("external_directory", "*", "ask"),
      rule("external_directory", within(bundle.root), "allow"),
    ],
  }
}

export function agents(bundle: Bundle): AgentDefinition[] {
  return [orchestrator(bundle), ...bundle.personas.map((persona) => reviewer(bundle, persona))]
}

/** Instruction appended after the user's text, so attachment mention offsets stay valid. */
export function commandText(skill: string, text: string): string {
  const instruction = `Follow the attached ${skill} skill for the request above.`
  return text.trim() ? `${text}\n\n${instruction}` : `Follow the attached ${skill} skill.`
}

/** Reason to refuse a subagent call from the orchestrator, or undefined to allow it. */
export function dispatchViolation(input: unknown): string | undefined {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  if (args.sessionID !== undefined && args.sessionID !== null && args.sessionID !== "") {
    return "EGM reviewers must start in a fresh child session. Omit sessionID; never continue a reviewer."
  }
  if (args.background === true) {
    return "EGM reviewers must run in the foreground. Omit background and wait for completion."
  }
}

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { frontmatter, loadBundle, REVIEWERS, validateRoot } from "../src/bundle.ts"
import type { Bundle } from "../src/bundle.ts"
import { agents, commandText, dispatchViolation, orchestrator, reviewer } from "../src/policy.ts"
import type { Rule } from "../src/policy.ts"

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "bundle.mjs")

// Mirrors the V2 base policy that every agent starts with.
const BASE: Rule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]

const wildcard = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, "s").test(value)

function evaluate(rules: readonly Rule[], action: string, resource: string) {
  return [...BASE, ...rules].findLast((rule) => wildcard(rule.action, action) && wildcard(rule.resource, resource))?.effect ?? "ask"
}

async function fakeCheckout(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "egm-source-"))
  await mkdir(path.join(root, "agents"))
  for (const file of REVIEWERS) {
    const name = `egm-${file.replaceAll("_", "-")}`
    await writeFile(path.join(root, "agents", `${file}.md`), `---\nname: ${name}\ndescription: ${file}\n---\n\nPersona ${file}.\n`)
  }
  for (const skill of ["egm-review", "egm-draft"]) {
    await mkdir(path.join(root, "skills", skill, "references"), { recursive: true })
    await writeFile(
      path.join(root, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\nlicense: Apache-2.0\ndisable-model-invocation: true\ndescription: >-\n  Runs ${skill}\n  for designs.\n---\n\n# ${skill}\n\nBody.\n`,
    )
    await writeFile(path.join(root, "skills", skill, "references", "ref.md"), "ref\n")
  }
  await mkdir(path.join(root, "resources"))
  await writeFile(path.join(root, "resources", "execution_instructions.md"), "x\n")
  await mkdir(path.join(root, "docs"))
  await writeFile(path.join(root, "docs", "index.md"), "x\n")
  await writeFile(path.join(root, "plugin.json"), JSON.stringify({ name: "egm", version: "9.9.9" }))
  await writeFile(path.join(root, "LICENSE"), "Apache\n")
  return root
}

async function fixture(): Promise<{ source: string; bundle: string }> {
  const source = await fakeCheckout()
  const bundle = path.join(await mkdtemp(path.join(os.tmpdir(), "egm-bundle-")), "bundle")
  execFileSync(process.execPath, [script, source, bundle])
  return { source, bundle }
}

test("frontmatter parses folded descriptions and strips the header", () => {
  const parsed = frontmatter("---\nname: egm-x\ndescription: >-\n  one\n  two\n---\n\n# Body\n")
  assert.equal(parsed?.data.name, "egm-x")
  assert.equal(parsed?.data.description, "one two")
  assert.equal(parsed?.body, "# Body")
})

test("bundle roots that would distort permission rules are rejected", () => {
  assert.throws(() => validateRoot("relative/path"))
  assert.throws(() => validateRoot("/tmp/a*b"))
  assert.throws(() => validateRoot("/tmp/a?b"))
  assert.throws(() => validateRoot("/tmp/x.env.d/egm"))
  validateRoot("/tmp/egm bundle")
})

test("bundle script copies resources and records hashes", async () => {
  const { bundle } = await fixture()
  const manifest = JSON.parse(await readFile(path.join(bundle, "installation.json"), "utf8"))
  assert.equal(manifest.version, "9.9.9")
  assert.ok(manifest.sha256["skills/egm-review/SKILL.md"])
  assert.ok(manifest.sha256["agents/zoom_out.md"])
  assert.throws(() => execFileSync(process.execPath, [script, path.dirname(bundle), bundle], { stdio: "pipe" }))
})

test("loadBundle reads personas and skills", async () => {
  const { bundle } = await fixture()
  const loaded = await loadBundle(bundle, { verify: true })
  assert.deepEqual(
    loaded.personas.map((persona) => persona.id),
    REVIEWERS.map((file) => `egm-${file.replaceAll("_", "-")}`),
  )
  assert.deepEqual(
    loaded.skills.map((skill) => skill.id),
    ["egm-draft", "egm-review"],
  )
  const review = loaded.skills.find((skill) => skill.id === "egm-review")!
  assert.equal(review.autoinvoke, false)
  assert.equal(review.description, "Runs egm-review for designs.")
  assert.ok(review.content.startsWith("# egm-review"))
  assert.equal(path.basename(path.dirname(review.path)), "egm-review")
})

test("loadBundle rejects modified or unlisted files", async () => {
  const { bundle } = await fixture()
  await writeFile(path.join(bundle, "agents", "style.md"), "---\nname: egm-style\n---\ntampered\n")
  await assert.rejects(loadBundle(bundle, { verify: true }), /modified agents\/style.md/)
  await loadBundle(bundle, { verify: false })

  const second = await fixture()
  await writeFile(path.join(second.bundle, "skills", "egm-review", "extra.md"), "x")
  await assert.rejects(loadBundle(second.bundle, { verify: true }), /unlisted skills\/egm-review\/extra.md/)
})

test("reviewers are read-only and confined to the project and bundle", async () => {
  const loaded: Bundle = await loadBundle((await fixture()).bundle, { verify: true })
  const rules = reviewer(loaded, loaded.personas[0]!).permissions
  assert.equal(evaluate(rules, "read", "src/design.md"), "allow")
  assert.equal(evaluate(rules, "read", ".env"), "deny")
  assert.equal(evaluate(rules, "read", "config/.env.local"), "deny")
  assert.equal(evaluate(rules, "read", ".env.example"), "allow")
  assert.equal(evaluate(rules, "glob", "**/*.md"), "allow")
  for (const action of ["grep", "edit", "shell", "subagent", "skill", "webfetch", "question", "execute", "opencode_read_mcp_resource"]) {
    assert.equal(evaluate(rules, action, "anything"), "deny", action)
  }
  assert.equal(evaluate(rules, "external_directory", `${loaded.root}/*`), "allow")
  assert.equal(evaluate(rules, "external_directory", "/etc/*"), "deny")
})

test("the orchestrator may launch only reviewers and load only EGM skills", async () => {
  const loaded = await loadBundle((await fixture()).bundle, { verify: true })
  const rules = orchestrator(loaded).permissions
  for (const persona of loaded.personas) assert.equal(evaluate(rules, "subagent", persona.id), "allow")
  assert.equal(evaluate(rules, "subagent", "general"), "deny")
  assert.equal(evaluate(rules, "subagent", "egm-synthesizer"), "deny")
  assert.equal(evaluate(rules, "skill", "egm-review"), "allow")
  assert.equal(evaluate(rules, "skill", "other"), "deny")
  assert.equal(evaluate(rules, "edit", "report.md"), "ask")
  assert.equal(evaluate(rules, "shell", "ls"), "ask")
  assert.equal(evaluate(rules, "read", ".env"), "ask")
  assert.equal(evaluate(rules, "question", "*"), "allow")
  assert.equal(evaluate(rules, "external_directory", `${loaded.root}/*`), "allow")
  assert.equal(evaluate(rules, "external_directory", "/etc/*"), "ask")
  assert.equal(agents(loaded).length, 1 + REVIEWERS.length)
})

test("dispatch rejects reused or background reviewer sessions", () => {
  assert.equal(dispatchViolation({ agent: "egm-style", prompt: "x", description: "y" }), undefined)
  assert.match(dispatchViolation({ agent: "egm-style", sessionID: "ses_1" })!, /fresh child session/)
  assert.match(dispatchViolation({ agent: "egm-style", background: true })!, /foreground/)
  assert.equal(dispatchViolation({ agent: "egm-style", background: false }), undefined)
})

test("command text keeps user text first and literal", () => {
  assert.equal(commandText("egm-review", "!`rm -rf /` design.md"), "!`rm -rf /` design.md\n\nFollow the attached egm-review skill for the request above.")
  assert.equal(commandText("egm-review", "  "), "Follow the attached egm-review skill.")
})

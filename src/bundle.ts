import { createHash } from "node:crypto"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

/** Reviewer persona files, in the order the canonical skills use them. */
export const REVIEWERS = [
  "codebase_details",
  "comprehension",
  "design_critic",
  "implementation_readiness",
  "structural",
  "style",
  "zoom_out",
] as const

/** Resource trees and files copied by scripts/bundle.mjs and covered by installation.json. */
export const TREES = ["skills", "agents", "resources", "docs"] as const
export const FILES = ["plugin.json", "LICENSE", "README.md", "TESTING.md"] as const
export const MANIFEST = "installation.json"

export interface Persona {
  /** Canonical frontmatter name, used as the OpenCode agent ID. */
  readonly id: string
  readonly file: string
  readonly path: string
}

export interface SkillDocument {
  readonly id: string
  readonly description?: string
  readonly autoinvoke?: boolean
  readonly path: string
  readonly content: string
}

export interface Manifest {
  readonly name?: string
  readonly version?: string
  readonly source_commit?: string
  readonly sha256: Readonly<Record<string, string>>
}

export interface Bundle {
  readonly root: string
  readonly version?: string
  readonly personas: readonly Persona[]
  readonly skills: readonly SkillDocument[]
  readonly manifest?: Manifest
}

export interface Frontmatter {
  readonly data: Readonly<Record<string, string>>
  readonly body: string
}

/** Parse the small YAML subset used by EGM frontmatter without a runtime YAML dependency. */
export function frontmatter(text: string): Frontmatter | undefined {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  if (lines[0]?.trim() !== "---") return
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end === -1) return
  const data: Record<string, string> = {}
  for (let index = 1; index < end; index++) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index]!)
    if (!match) continue
    const [, key, raw] = match
    const value = raw!.trim()
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = []
      while (index + 1 < end && (/^\s+\S/.test(lines[index + 1]!) || lines[index + 1]!.trim() === "")) {
        block.push(lines[++index]!.trim())
      }
      data[key!] = value.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim()
      continue
    }
    data[key!] = value.replace(/^(["'])(.*)\1$/, "$2")
  }
  return { data, body: lines.slice(end + 1).join("\n").trim() }
}

function canonicalName(file: string, text: string): string {
  const name = frontmatter(text)?.data.name
  if (!name || !/^egm-[a-z-]+$/.test(name)) throw new Error(`Missing canonical egm-* name: ${file}`)
  return name
}

function flag(value: string | undefined): boolean | undefined {
  if (value === undefined) return
  const normalized = value.trim().toLowerCase()
  if (["true", "yes", "on", "1"].includes(normalized)) return true
  if (["false", "no", "off", "0"].includes(normalized)) return false
}

/**
 * Permission rules match whole values where `*` spans `/`, so a root containing
 * wildcards or `.env.` would widen or deny every rule written against it.
 */
export function validateRoot(root: string): void {
  if (!path.isAbsolute(root)) throw new Error(`EGM bundle root must be absolute: ${root}`)
  if (/[\\*?\n\r]/.test(root)) throw new Error("EGM bundle root contains wildcard or control characters")
  if (root.toLowerCase().includes(".env.")) throw new Error("EGM bundle root matches the .env read rules")
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) return walk(full)
      if (entry.isFile()) return [full]
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in the EGM bundle: ${full}`)
      return []
    }),
  )
  return nested.flat()
}

/** Every file a manifest must cover: the copied trees and top-level files. */
export async function bundleFiles(root: string): Promise<string[]> {
  const trees = await Promise.all(TREES.map((tree) => walk(path.join(root, tree))))
  const files = await Promise.all(
    FILES.map(async (file) => {
      const full = path.join(root, file)
      return (await stat(full).catch(() => undefined))?.isFile() ? [full] : []
    }),
  )
  return [...trees.flat(), ...files.flat()]
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort()
}

export async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

/** Reject a bundle whose files differ from, or are missing from, its manifest. */
export async function verify(root: string, manifest: Manifest): Promise<void> {
  const expected = Object.keys(manifest.sha256).sort()
  const actual = await bundleFiles(root)
  const missing = expected.filter((file) => !actual.includes(file))
  const extra = actual.filter((file) => !(file in manifest.sha256))
  const changed: string[] = []
  for (const file of expected) {
    if (missing.includes(file)) continue
    if ((await sha256(path.join(root, file))) !== manifest.sha256[file]) changed.push(file)
  }
  const problems = [
    ...missing.map((file) => `missing ${file}`),
    ...extra.map((file) => `unlisted ${file}`),
    ...changed.map((file) => `modified ${file}`),
  ]
  if (problems.length > 0) {
    throw new Error(`EGM bundle does not match ${MANIFEST}: ${problems.slice(0, 10).join(", ")}`)
  }
}

export async function loadBundle(input: string, options: { verify: boolean }): Promise<Bundle> {
  validateRoot(input)
  const root = await realpath(input).catch(() => {
    throw new Error(`EGM bundle root not found: ${input}. Run "npm run bundle -- <egm-checkout>" or set the "root" option.`)
  })
  validateRoot(root)

  const manifestText = await readFile(path.join(root, MANIFEST), "utf8").catch(() => undefined)
  const manifest = manifestText === undefined ? undefined : (JSON.parse(manifestText) as Manifest)
  if (manifest && options.verify) await verify(root, manifest)

  const personas = await Promise.all(
    REVIEWERS.map(async (file) => {
      const full = path.join(root, "agents", `${file}.md`)
      return { id: canonicalName(full, await readFile(full, "utf8")), file, path: full }
    }),
  )

  const skillDirectories = (await readdir(path.join(root, "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const skills = (
    await Promise.all(
      skillDirectories.map(async (directory) => {
        const full = path.join(root, "skills", directory, "SKILL.md")
        const text = await readFile(full, "utf8").catch(() => undefined)
        if (text === undefined) return []
        const id = canonicalName(full, text)
        const parsed = frontmatter(text)!
        const disabled = flag(parsed.data["disable-model-invocation"])
        return [
          {
            id,
            description: parsed.data.description,
            autoinvoke: disabled === true ? false : undefined,
            path: full,
            content: parsed.body,
          } satisfies SkillDocument,
        ]
      }),
    )
  ).flat()
  if (skills.length === 0) throw new Error(`No EGM skills found under ${path.join(root, "skills")}`)

  const metadata = await readFile(path.join(root, "plugin.json"), "utf8")
    .then((text) => JSON.parse(text) as { version?: string })
    .catch(() => undefined)

  return { root, version: manifest?.version ?? metadata?.version, personas, skills, manifest }
}

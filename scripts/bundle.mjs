#!/usr/bin/env node
// Copy the canonical EGM resources into a new bundle directory and record their hashes.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const TREES = ["skills", "agents", "resources", "docs"]
const FILES = ["plugin.json", "LICENSE", "README.md", "TESTING.md"]
const pluginDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const [sourceArgument, destinationArgument] = process.argv.slice(2)
if (!sourceArgument) {
  console.error("Usage: npm run bundle -- <egm-checkout> [destination]")
  process.exit(2)
}

const source = await realpath(path.resolve(sourceArgument))
const destination = path.resolve(destinationArgument ?? path.join(pluginDirectory, "bundle"))

if (await lstat(destination).catch(() => undefined)) {
  console.error(`Refusing to overwrite ${destination}. Remove it or choose a new destination.`)
  process.exit(1)
}
if (/[\\*?\n\r]/.test(destination) || destination.toLowerCase().includes(".env.")) {
  console.error("Destination contains wildcard characters or matches the .env read rules.")
  process.exit(1)
}
for (const entry of [...TREES, "plugin.json"]) {
  if (!(await lstat(path.join(source, entry)).catch(() => undefined))) {
    console.error(`${source} is not an EGM checkout: missing ${entry}`)
    process.exit(1)
  }
}

await mkdir(destination, { recursive: true })
for (const tree of TREES) {
  await cp(path.join(source, tree), path.join(destination, tree), { recursive: true, dereference: true })
}
for (const file of FILES) {
  await cp(path.join(source, file), path.join(destination, file)).catch(() => undefined)
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(directory, entry.name)
      return entry.isDirectory() ? walk(full) : entry.isFile() ? [full] : []
    }),
  )
  return nested.flat()
}

const files = (await walk(destination)).map((file) => path.relative(destination, file).split(path.sep).join("/")).sort()
const sha256 = {}
for (const file of files) {
  sha256[file] = createHash("sha256").update(await readFile(path.join(destination, file))).digest("hex")
}

let sourceCommit
try {
  sourceCommit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
} catch {}

const metadata = JSON.parse(await readFile(path.join(destination, "plugin.json"), "utf8"))
const pluginPackage = JSON.parse(await readFile(path.join(pluginDirectory, "package.json"), "utf8"))
await writeFile(
  path.join(destination, "installation.json"),
  JSON.stringify(
    {
      name: metadata.name,
      version: metadata.version,
      ...(sourceCommit ? { source_commit: sourceCommit } : {}),
      host: "opencode",
      host_plugin_api: pluginPackage.dependencies["@opencode/plugin"],
      status: "experimental",
      sha256,
    },
    null,
    2,
  ) + "\n",
)
console.log(destination)

# EGM for OpenCode V2 (experimental)

An OpenCode V2 server plugin for the [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model) (EGM). It ports the [OpenCode V1 adapter](https://github.com/google/elephant-goldfish-model/blob/main/docs/opencode.md) to the V2 plugin API. It targets `@opencode/plugin` 2.2.5 and the V2 `subagent` and `permissions` interfaces.

The V1 adapter generated an `opencode.json` that you selected with `OPENCODE_CONFIG`. This plugin registers the same parts at runtime instead:

| Part | V1 adapter | This plugin |
| --- | --- | --- |
| `egm` primary agent | `agent.egm` in generated config | `ctx.agent.transform` |
| Seven read-only reviewers | `agent.egm-*`, `mode: subagent` | `ctx.agent.transform` |
| Seven skills | Symlinked `skills.paths` directory | `ctx.skill.transform`, from the bundle |
| Seven commands | Config `command` templates | `ctx.command.transform` |
| Reviewer dispatch | V1 `task` with `subagent_type` | V2 `subagent` with `agent` |
| Fresh foreground reviewers | Prompt instructions only | Prompt instructions plus a `tool` hook that rejects `sessionID` and `background` |
| Provenance | `installation.json` written at install | Same manifest, checked every time the plugin loads |

## Install

You need Node.js 22.6 or later, and an EGM checkout pinned to a known commit.

```sh
git -C /path/to/elephant-goldfish-model rev-parse HEAD
npm install
npm run bundle -- /path/to/elephant-goldfish-model
```

`npm run bundle` copies `skills/`, `agents/`, `resources/`, `docs/`, `plugin.json`, `LICENSE`, `README.md`, and `TESTING.md` into `./bundle`. It then writes `bundle/installation.json`, which lists the source commit and the SHA-256 hash of every copied file. If `./bundle` already exists, the script stops. To change the EGM version, delete `./bundle` and run the script again.

Add the plugin directory to a project's `opencode.json(c)`, or to your global config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/egm-opencode-v2"],
}
```

You can also put the directory in `.opencode/plugins/`. OpenCode reloads the config on its own, so you don't need to restart it. Run `/reload` if you want to force a reload.

### Options

Use the object form to pass options:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/egm-opencode-v2",
      "options": { "root": "~/egm-bundles/0.1.0", "defaultAgent": true },
    },
  ],
}
```

| Option | Default | Effect |
| --- | --- | --- |
| `root` | `<plugin>/bundle` | EGM bundle root. Relative paths resolve from the plugin directory. You can also point it at an EGM checkout. |
| `verify` | `true` | If `installation.json` exists, the plugin refuses to load when any file is missing, changed, or not listed. |
| `defaultAgent` | `false` | Makes `egm` the default primary agent. |
| `isolateSkills` | `true` | Hides and denies EGM skills for every agent except `egm`. |

The root path must be absolute after resolution. It must not contain `*`, `?`, backslashes, or line breaks, and it must not contain `.env.`. These characters would change what the permission rules match.

## Use

Select the `egm` agent, then ask for a skill in an ordinary message:

```text
Use the egm-review skill to review /absolute/path/design.md.
```

You can also use a command, such as `/egm-review design.md`. The command switches the session to `egm`, attaches the skill, and passes your text through unchanged. V1 command templates evaluated shell markers (an exclamation mark followed by a command in backticks) in their arguments. V2 plugin commands don't do this, so pasted review material can't run commands.

Running a skill calls a model. Loading the plugin and inspecting agents, skills, and commands do not.

## Paths and dispatch

The `egm` system prompt includes the absolute bundle root and the roster of reviewers with their persona files. Paths resolve as in V1:

- `agents/`, `resources/`, and `docs/` resolve against the bundle root.
- `references/` resolves against the skill directory.
- User files and outputs resolve against the project directory.

The `egm` agent dispatches reviewers directly with the V2 `subagent` tool. It passes the persona name as `agent`, plus a `description` and a `prompt`. Each reviewer starts in a fresh child session in the foreground. If a call from `egm` includes `sessionID` or `background: true`, the plugin rejects it before it runs. The `egm` agent can launch only the seven reviewers.

No synthesizer, bootstrap orchestrator, worker, or scout agent is installed. If a skill needs one, `egm` stops instead of substituting a reviewer. The approval gates and the `EGM artifact directory: <path>` rule from the V1 guide are part of the `egm` system prompt.

## Permissions

Each agent's rules are appended after the V2 base policy. The last matching rule wins.

**Reviewers** deny everything, then allow:

- `read`, except `*.env` and `*.env.*` (`*.env.example` stays allowed)
- `glob`
- `external_directory` for the bundle root only

`grep` stays denied because it searches file contents without applying per-file `read` rules. The base deny also covers editing, shell, web tools, MCP tools and resources, Code Mode, skills, questions, and subagents.

**`egm`** asks by default and allows:

- `read`, except `.env` files, which ask
- `glob` and `grep`
- `question`
- the EGM skills (other skills are denied)
- the seven reviewers (other subagents are denied)
- the bundle root (other external directories ask)

Writes ask for approval.

OpenCode merges global, project, and managed configuration, and other plugins can transform agents after this one. Check the effective agents before relying on these rules:

```sh
opencode api get /api/agent/egm
opencode api get /api/agent/egm-style
```

Permission rules control tool access. They don't isolate processes or the filesystem. A fresh child session alone does not prove Goldfish isolation.

## Development

```sh
npm run typecheck
npm test
```

The tests build a fixture bundle and check frontmatter parsing, manifest verification, root validation, permission outcomes, dispatch checks, and command text.

## License

Apache-2.0, matching EGM. The `bundle/` directory contains unmodified EGM resources under their own license.

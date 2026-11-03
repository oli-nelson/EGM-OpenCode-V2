import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin, Skill } from "@opencode/plugin"
import { loadBundle } from "./bundle.ts"
import { agents, commandText, dispatchViolation, ORCHESTRATOR } from "./policy.ts"

const pluginDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function resolveRoot(option: unknown): string {
  if (option === undefined) return path.join(pluginDirectory, "bundle")
  if (typeof option !== "string" || option.trim() === "") throw new Error('The "root" option must be a path string')
  const expanded = option.replace(/^~(?=$|\/)/, os.homedir())
  return path.resolve(pluginDirectory, expanded)
}

export default Plugin.define({
  id: "egm",
  async setup(ctx) {
    const bundle = await loadBundle(resolveRoot(ctx.options.root), { verify: ctx.options.verify !== false })
    const definitions = agents(bundle)
    const reviewers = new Set(bundle.personas.map((persona) => persona.id))

    await ctx.agent.transform((editor) => {
      for (const definition of definitions) {
        // update creates the agent from the V2 base policy when it does not exist yet.
        editor.update(definition.id, (agent) => {
          agent.description = definition.description
          agent.mode = definition.mode
          agent.color = definition.color
          agent.system = definition.system
          agent.permissions.push(...definition.permissions.map((rule) => ({ ...rule })))
        })
      }
      if (ctx.options.isolateSkills !== false) {
        // EGM skills assume the egm agent's dispatch rules; hide them from every other agent.
        for (const agent of editor.list()) {
          if (agent.id === ORCHESTRATOR || reviewers.has(agent.id)) continue
          editor.update(agent.id, (draft) => {
            draft.permissions.push(...bundle.skills.map((skill) => ({ action: "skill", resource: skill.id, effect: "deny" as const })))
          })
        }
      }
      if (ctx.options.defaultAgent === true) editor.default(ORCHESTRATOR)
    })

    await ctx.skill.transform((editor) => {
      for (const skill of bundle.skills) {
        editor.add({
          id: Skill.ID.make(skill.id),
          name: Skill.Name.make(skill.id),
          ...(skill.description === undefined ? {} : { description: skill.description }),
          ...(skill.autoinvoke === undefined ? {} : { autoinvoke: skill.autoinvoke }),
          path: Skill.Info.fields.path.make(skill.path),
          content: skill.content,
        })
      }
    })

    // Plugin commands receive the user's text verbatim: unlike V1 templates, no shell
    // markers are expanded, so pasted review material cannot run commands.
    await ctx.command.transform((editor) => {
      for (const skill of bundle.skills) {
        editor.add({
          name: skill.id,
          description: `Run ${skill.id} with the egm agent (experimental)`,
          execute: async ({ sessionID, prompt, delivery }) => {
            const session = await ctx.session.get({ sessionID })
            if (session.agent !== ORCHESTRATOR) await ctx.session.switchAgent({ sessionID, agent: ORCHESTRATOR })
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              text: commandText(skill.id, prompt.text),
              skills: [...(prompt.skills ?? []), { id: Skill.ID.make(skill.id) }],
              delivery,
            })
          },
        })
      }
    })

    // Enforce fresh, foreground reviewer sessions instead of relying on the prompt alone.
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "subagent" || event.agent !== ORCHESTRATOR) return
      const violation = dispatchViolation(event.input)
      if (violation) throw new Error(violation)
    })
  },
})

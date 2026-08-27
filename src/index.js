/**
 * opencode-auto-instruct
 *
 * Injects configurable instructions into agent sessions when events occur.
 * Instructions are hidden from the user (injected via system.transform) but
 * visible to the agent on its next LLM call after the triggering event.
 *
 * Config file: ~/.config/opencode/auto-instruct.json
 * See README.md for the full config schema.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG_FILE = join(homedir(), '.config', 'opencode', 'auto-instruct.json')
const PLUGIN_NAME = 'opencode-auto-instruct'

export default async function AutoInstructPlugin({ client }, options = {}) {
  // ── Logging ──────────────────────────────────────────────────────────────

  const log = (msg, err, level = err ? 'error' : 'info') => {
    const detail = err ? `: ${err instanceof Error ? err.stack ?? err.message : String(err)}` : ''
    const message = `[${PLUGIN_NAME}] ${msg}${detail}`
    try {
      const result = client.app.log({ body: { service: PLUGIN_NAME, level, message } })
      result?.catch?.(() => process.stderr.write(message + '\n'))
    } catch {
      process.stderr.write(message + '\n')
    }
  }

  // ── Config ────────────────────────────────────────────────────────────────

  let fileOptions = {}
  try {
    fileOptions = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log('config file load failed', err, 'warn')
    }
  }

  // Explicit options (from opencode.jsonc plugin block) take precedence over
  // the file; rules are merged (file rules first, then options rules).
  const fileRules = Array.isArray(fileOptions.rules) ? fileOptions.rules : []
  const optionRules = Array.isArray(options.rules) ? options.rules : []
  const rules = [...fileRules, ...optionRules]

  log(`loaded ${rules.length} rule(s)`)

  // ── State ─────────────────────────────────────────────────────────────────

  /** sessionID → agent name (populated from session.created and lazy-fetched) */
  const sessionAgents = new Map()

  /** sessionID → string[] of pending instructions to inject on next LLM call */
  const pending = new Map()

  // ── Helpers ───────────────────────────────────────────────────────────────

  function addPending(sessionID, instruction) {
    if (!pending.has(sessionID)) pending.set(sessionID, [])
    pending.get(sessionID).push(instruction)
  }

  async function resolveAgent(sessionID) {
    if (sessionAgents.has(sessionID)) return sessionAgents.get(sessionID)
    try {
      const res = await client.session.get({ path: { id: sessionID } })
      const agent = res?.data?.agent ?? null
      if (agent) sessionAgents.set(sessionID, agent)
      return agent
    } catch {
      return null
    }
  }

  /**
   * Returns true when the agent name matches the rule's agents filter.
   *
   * rule.agents may be:
   *   - absent / "*"          → match any agent
   *   - "agent-name"          → match one specific agent
   *   - ["a", "b"]            → match any in the list
   */
  function matchesAgents(rule, agentName) {
    if (!rule.agents || rule.agents === '*') return true
    if (!agentName) return false
    if (Array.isArray(rule.agents)) return rule.agents.includes(agentName)
    return rule.agents === agentName
  }

  /**
   * Evaluates the optional condition on the event.
   * Returns true when there is no condition (unconditional rule).
   *
   * Supported condition types:
   *   allTodosComplete   — every todo has status "completed"
   *   anyTodosComplete   — at least one todo has status "completed"
   *   noTodosInProgress  — no todo has status "in_progress"
   *   hasTodos           — todo list is non-empty
   *   messageFinished    — message.updated with info.finish truthy
   *   toolName           — tool.execute.after where tool matches condition.tool
   */
  function checkCondition(rule, event) {
    const cond = rule.condition
    if (!cond) return true

    const props = event.properties ?? {}

    switch (cond.type) {
      case 'allTodosComplete': {
        const todos = props.todos ?? []
        return todos.length > 0 && todos.every(t => t.status === 'completed')
      }
      case 'anyTodosComplete': {
        const todos = props.todos ?? []
        return todos.some(t => t.status === 'completed')
      }
      case 'noTodosInProgress': {
        const todos = props.todos ?? []
        return !todos.some(t => t.status === 'in_progress')
      }
      case 'hasTodos': {
        const todos = props.todos ?? []
        return todos.length > 0
      }
      case 'messageFinished':
        return !!props.info?.finish
      case 'toolName':
        return props.tool === cond.tool
      default:
        log(`unknown condition type: ${JSON.stringify(cond.type)}`, null, 'warn')
        return false
    }
  }

  // ── Plugin hooks ──────────────────────────────────────────────────────────

  return {
    /**
     * Listen to all events. When a rule matches, queue its instruction for
     * injection into the next LLM call for that session.
     */
    event: async ({ event }) => {
      try {
        // Extract session ID — different events place it in different spots
        const sessionID =
          event.properties?.sessionID ??
          event.properties?.info?.id

        if (!sessionID) return

        // Cache agent name eagerly from session.created (avoids a client.session.get
        // call for every subsequent event on the same session)
        if (event.type === 'session.created') {
          const agent = event.properties?.info?.agent ?? null
          if (agent) sessionAgents.set(sessionID, agent)
        }

        const agentName = await resolveAgent(sessionID)

        for (const rule of rules) {
          if (rule.event !== event.type) continue
          if (!matchesAgents(rule, agentName)) continue
          if (!checkCondition(rule, event)) continue
          if (!rule.instruction) continue

          addPending(sessionID, rule.instruction)
          log(
            `queued instruction for session=${sessionID} ` +
            `agent=${agentName ?? 'unknown'} ` +
            `event=${event.type} ` +
            `rule=${rule.id ?? '(unnamed)'}`,
          )
        }
      } catch (err) {
        log('event handler error', err)
      }
    },

    /**
     * On every LLM call, check whether there are pending instructions for
     * this session and inject them into the system prompt. Instructions are
     * consumed immediately so they fire exactly once per trigger.
     */
    'experimental.chat.system.transform': async (input, output) => {
      try {
        const sessionID = input?.sessionID
        if (!sessionID) return

        const instructions = pending.get(sessionID)
        if (!instructions?.length) return

        pending.delete(sessionID)

        for (const instruction of instructions) {
          output.system.push(instruction)
        }

        log(`injected ${instructions.length} instruction(s) for session ${sessionID}`)
      } catch (err) {
        log('system.transform error', err)
      }
    },
  }
}

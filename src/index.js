/**
 * opencode-auto-instruct
 *
 * Sends configurable instructions as real conversation messages when events
 * occur in an agent session. Instructions are delivered via the session prompt
 * API so they appear as visible turns that the agent responds to explicitly.
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

  // debug: true in the config enables verbose per-event logging
  const debug = fileOptions.debug === true || options.debug === true

  const dbg = debug ? (msg) => log(`[debug] ${msg}`) : () => {}

  log(`loaded ${rules.length} rule(s)${debug ? ' (debug mode ON)' : ''}`)

  // ── State ─────────────────────────────────────────────────────────────────

  /** sessionID → agent name (populated from session.created and lazy-fetched) */
  const sessionAgents = new Map()

  /**
   * sessionID → todos[] snapshot from the last todo.updated event.
   * Used by transition-detecting conditions (todoListCreated, todoListCleared,
   * firstTodoStarted) to compare current state against the previous state.
   * Updated AFTER all rules are evaluated for a todo.updated event, so every
   * condition sees the same consistent prev/current pair within one event.
   */
  const prevTodosMap = new Map()

  /**
   * Set of sessionIDs where allTodosCompleteOnce has already fired.
   * Populated after the rule loop so all matching rules see the unfired state.
   */
  const allTodosCompleteOnceFiredSessions = new Set()

  // ── Helpers ───────────────────────────────────────────────────────────────

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
   * Transition-detecting conditions (todoListCreated, todoListCleared,
   * firstTodoStarted) read prevTodosMap but never write to it — the caller
   * updates that map after all rules have been evaluated.
   *
   * allTodosCompleteOnce reads allTodosCompleteOnceFiredSessions but never
   * writes to it — the caller marks the session after the loop.
   *
   * Supported condition types:
   *   allTodosComplete      — every todo has status "completed"
   *   anyTodosComplete      — at least one todo has status "completed"
   *   noTodosInProgress     — no todo has status "in_progress"
   *   hasTodos              — todo list is non-empty
   *   todoListCreated       — first todo.updated where list transitions from empty to non-empty
   *   todoListCleared       — todo.updated where list transitions from non-empty to empty
   *   firstTodoStarted      — first todo.updated where an item transitions to in_progress
   *   allTodosCompleteOnce  — like allTodosComplete, but fires at most once per session
   *   todoCountAtLeast      — list has at least condition.count items
   *   messageFinished       — message.updated with info.finish truthy
   *   toolName              — tool.execute.after where tool matches condition.tool
   *   toolNameIn            — tool.execute.after where tool is in condition.tools array
   */
  function checkCondition(rule, event, sessionID) {
    const cond = rule.condition
    if (!cond) {
      dbg(`rule=${rule.id ?? '(unnamed)'} no condition → match`)
      return true
    }

    const props = event.properties ?? {}
    const prev = prevTodosMap.get(sessionID) ?? []

    let result
    switch (cond.type) {
      case 'allTodosComplete': {
        const todos = props.todos ?? []
        result = todos.length > 0 && todos.every(t => t.status === 'completed')
        dbg(`rule=${rule.id ?? '(unnamed)'} allTodosComplete: count=${todos.length} result=${result}`)
        break
      }
      case 'anyTodosComplete': {
        const todos = props.todos ?? []
        result = todos.some(t => t.status === 'completed')
        dbg(`rule=${rule.id ?? '(unnamed)'} anyTodosComplete: result=${result}`)
        break
      }
      case 'noTodosInProgress': {
        const todos = props.todos ?? []
        result = !todos.some(t => t.status === 'in_progress')
        dbg(`rule=${rule.id ?? '(unnamed)'} noTodosInProgress: result=${result}`)
        break
      }
      case 'hasTodos': {
        const todos = props.todos ?? []
        result = todos.length > 0
        dbg(`rule=${rule.id ?? '(unnamed)'} hasTodos: count=${todos.length} result=${result}`)
        break
      }
      case 'todoListCreated': {
        const current = props.todos ?? []
        result = prev.length === 0 && current.length > 0
        dbg(`rule=${rule.id ?? '(unnamed)'} todoListCreated: prev=${prev.length} current=${current.length} result=${result}`)
        break
      }
      case 'todoListCleared': {
        const current = props.todos ?? []
        result = prev.length > 0 && current.length === 0
        dbg(`rule=${rule.id ?? '(unnamed)'} todoListCleared: prev=${prev.length} current=${current.length} result=${result}`)
        break
      }
      case 'firstTodoStarted': {
        const current = props.todos ?? []
        const hadInProgress = prev.some(t => t.status === 'in_progress')
        const hasInProgress = current.some(t => t.status === 'in_progress')
        result = !hadInProgress && hasInProgress
        dbg(`rule=${rule.id ?? '(unnamed)'} firstTodoStarted: hadInProgress=${hadInProgress} hasInProgress=${hasInProgress} result=${result}`)
        break
      }
      case 'allTodosCompleteOnce': {
        const alreadyFired = allTodosCompleteOnceFiredSessions.has(sessionID)
        const todos = props.todos ?? []
        const allDone = todos.length > 0 && todos.every(t => t.status === 'completed')
        result = !alreadyFired && allDone
        dbg(`rule=${rule.id ?? '(unnamed)'} allTodosCompleteOnce: alreadyFired=${alreadyFired} allDone=${allDone} result=${result}`)
        break
      }
      case 'todoCountAtLeast': {
        const todos = props.todos ?? []
        const n = typeof cond.count === 'number' ? cond.count : 1
        result = todos.length >= n
        dbg(`rule=${rule.id ?? '(unnamed)'} todoCountAtLeast: count=${todos.length} threshold=${n} result=${result}`)
        break
      }
      case 'messageFinished':
        result = !!props.info?.finish
        dbg(`rule=${rule.id ?? '(unnamed)'} messageFinished: finish=${props.info?.finish} result=${result}`)
        break
      case 'toolName':
        result = props.tool === cond.tool
        dbg(`rule=${rule.id ?? '(unnamed)'} toolName: tool=${props.tool} expected=${cond.tool} result=${result}`)
        break
      case 'toolNameIn': {
        if (!Array.isArray(cond.tools)) {
          log(`toolNameIn condition missing tools array in rule ${rule.id ?? '(unnamed)'}`, null, 'warn')
          result = false
        } else {
          result = cond.tools.includes(props.tool)
          dbg(`rule=${rule.id ?? '(unnamed)'} toolNameIn: tool=${props.tool} tools=${JSON.stringify(cond.tools)} result=${result}`)
        }
        break
      }
      default:
        log(`unknown condition type: ${JSON.stringify(cond.type)}`, null, 'warn')
        result = false
    }

    return result
  }

  // ── Plugin hooks ──────────────────────────────────────────────────────────

  return {
    /**
     * Listen to all events. When a rule matches, send its instruction as a
     * new session message via client.session.promptAsync so the agent sees
     * and responds to it as a visible conversation turn.
     *
     * State updates (prevTodosMap, allTodosCompleteOnceFiredSessions) happen
     * AFTER the rule loop so all conditions within one event see a consistent
     * snapshot — avoids the ordering problem where the first rule's check
     * would change state seen by the second rule.
     */
    event: async ({ event }) => {
      try {
        // Extract session ID — different events place it in different spots
        const sessionID =
          event.properties?.sessionID ??
          event.properties?.info?.id

        // Log every event at debug level so we can see what's arriving and
        // whether sessionID is being resolved correctly.
        dbg(
          `event type=${event.type} ` +
          `sessionID=${sessionID ?? 'MISSING'} ` +
          `(from properties.sessionID=${event.properties?.sessionID ?? 'undefined'}, ` +
          `properties.info.id=${event.properties?.info?.id ?? 'undefined'})`,
        )

        if (!sessionID) {
          if (debug) {
            log(
              `[debug] event type=${event.type} skipped: no sessionID. ` +
              `Raw properties keys: ${JSON.stringify(Object.keys(event.properties ?? {}))}`,
            )
          }
          return
        }

        // Cache agent name eagerly from session.created (avoids a client.session.get
        // call for every subsequent event on the same session)
        if (event.type === 'session.created') {
          const agent = event.properties?.info?.agent ?? null
          if (agent) sessionAgents.set(sessionID, agent)
        }

        const agentName = await resolveAgent(sessionID)
        dbg(`session=${sessionID} agent=${agentName ?? 'unknown (not resolved yet)'}`)

        // For todo.updated, log the payload shape so we can verify the structure.
        if (event.type === 'todo.updated' && debug) {
          const todos = event.properties?.todos
          const prev = prevTodosMap.get(sessionID) ?? []
          log(
            `[debug] todo.updated session=${sessionID} ` +
            `todos=${todos === undefined ? 'MISSING (check event.properties keys: ' + JSON.stringify(Object.keys(event.properties ?? {})) + ')' : JSON.stringify(todos?.map(t => ({ status: t.status })))} ` +
            `prev=${JSON.stringify(prev.map(t => ({ status: t.status })))}`,
          )
        }

        // Track whether an allTodosCompleteOnce rule matched this event so we
        // can mark the session as fired after the loop (not during).
        let didFireAllTodosCompleteOnce = false

        for (const rule of rules) {
          if (rule.event !== event.type) continue
          if (!matchesAgents(rule, agentName)) {
            dbg(`rule=${rule.id ?? '(unnamed)'} skipped: agent=${agentName ?? 'unknown'} not in filter=${JSON.stringify(rule.agents)}`)
            continue
          }
          if (!checkCondition(rule, event, sessionID)) continue
          if (!rule.instruction) {
            dbg(`rule=${rule.id ?? '(unnamed)'} skipped: no instruction defined`)
            continue
          }

          try {
            await client.session.promptAsync({
              path: { id: sessionID },
              body: { parts: [{ type: 'text', text: rule.instruction, synthetic: rule.hidden === true }] },
            })
            log(
              `sent instruction for session=${sessionID} ` +
              `agent=${agentName ?? 'unknown'} ` +
              `event=${event.type} ` +
              `rule=${rule.id ?? '(unnamed)'}`,
            )
          } catch (err) {
            log(
              `failed to send instruction for session=${sessionID} ` +
              `rule=${rule.id ?? '(unnamed)'}`,
              err,
            )
          }

          if (rule.condition?.type === 'allTodosCompleteOnce') {
            didFireAllTodosCompleteOnce = true
          }
        }

        // Post-loop state updates — must come after all conditions are checked.
        if (didFireAllTodosCompleteOnce) {
          allTodosCompleteOnceFiredSessions.add(sessionID)
          dbg(`session=${sessionID} marked allTodosCompleteOnce as fired`)
        }
        if (event.type === 'todo.updated') {
          const snapshot = event.properties?.todos ?? []
          prevTodosMap.set(sessionID, snapshot)
          dbg(`session=${sessionID} prevTodosMap updated: ${snapshot.length} item(s)`)
        }
      } catch (err) {
        log('event handler error', err)
      }
    },
  }
}

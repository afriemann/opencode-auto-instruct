// src/core.js — opencode-auto-instruct runtime-agnostic core (design.md §3)
//
// Everything here is host-agnostic: rule loading/merging, agent filtering,
// all 12 condition evaluators operating on a NormalizedEvent, per-session
// state (todo-transition tracking, allTodosCompleteOnce), instruction
// framing text, and the evaluate() pass that turns one normalized event
// into an ordered list of delivery decisions. `plugin.v1.js` and
// `plugin.v2.js` are thin adapters that normalize each host's raw event
// into a NormalizedEvent, call evaluate(), and carry out the returned
// decisions via their own SDK.
//
// No default export: this file is imported, never scanned as a plugin
// candidate by either host's loader.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ---------------------------------------------------------------------------
// Config path resolution (design.md D8 -- injectable for safe testing)
// ---------------------------------------------------------------------------

/**
 * Resolves the rules config file path. Honors OPENCODE_AUTO_INSTRUCT_CONFIG
 * for tests (Layer 3 e2e) so no run ever touches the real user config file.
 */
export function resolveConfigPath() {
  return process.env.OPENCODE_AUTO_INSTRUCT_CONFIG
    || join(homedir(), '.config', 'opencode', 'auto-instruct.json')
}

// ---------------------------------------------------------------------------
// Rule loading
// ---------------------------------------------------------------------------

/**
 * Loads and merges rules from the config file and plugin options.
 * File rules are evaluated before option rules. A missing config file is
 * not an error. A malformed config file logs a warning and contributes no
 * rules.
 *
 * @param {(msg: string, err?: any, level?: string) => void} log
 * @param {Record<string, any>} options
 * @returns {Promise<{ rules: any[], debug: boolean }>}
 */
export async function loadRules(log, options = {}) {
  let fileOptions = {}
  try {
    fileOptions = JSON.parse(await readFile(resolveConfigPath(), 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log('config file load failed', err, 'warn')
    }
  }

  const fileRules = Array.isArray(fileOptions.rules) ? fileOptions.rules : []
  const optionRules = Array.isArray(options.rules) ? options.rules : []
  const rules = [...fileRules, ...optionRules]

  const debug = fileOptions.debug === true || options.debug === true

  return { rules, debug }
}

// ---------------------------------------------------------------------------
// Agent filtering
// ---------------------------------------------------------------------------

/**
 * Returns true when the agent name matches the rule's agents filter.
 * rule.agents may be absent/"*" (match any), a string (match one), or an
 * array (match any in the list). An unresolved agent fails any specific
 * filter.
 */
export function matchesAgents(rule, agentName) {
  if (!rule.agents || rule.agents === '*') return true
  if (!agentName) return false
  if (Array.isArray(rule.agents)) return rule.agents.includes(agentName)
  return rule.agents === agentName
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

/**
 * Condition types with no V2 event or tool-call source at all, as of
 * @opencode/cli 2.0.4/2.0.6. `toolName`/`toolNameIn` are NOT in this set --
 * V2 exposes a separate hook registration, `ctx.tool.hook("execute.after",
 * ...)`, that fires for every tool call and carries the tool name directly
 * (confirmed by reading the V2 source, `packages/core/src/tool.ts` and
 * `packages/plugin/src/promise/adapter.ts`, tag v2.0.6). The remaining nine
 * are todo-derived: exhaustively enumerating V2's built-in tool
 * registrations found no server-side todo-management tool at all -- there
 * is nothing for any hook to observe todo state from. Exported so
 * plugin.v2.js can log a one-time per-rule warning at load time for any
 * rule using one of these.
 */
export const V2_UNSUPPORTED_CONDITION_TYPES = new Set([
  'allTodosComplete', 'anyTodosComplete', 'noTodosInProgress', 'hasTodos',
  'todoListCreated', 'todoListCleared', 'firstTodoStarted',
  'allTodosCompleteOnce', 'todoCountAtLeast',
])

/**
 * V1 trigger event types with no V2 event source at all. `tool.execute.after`
 * is NOT in this set -- it is reachable on V2 via `ctx.tool.hook`, a
 * separate intake path from `ctx.event.subscribe()` (see
 * V2_UNSUPPORTED_CONDITION_TYPES). A rule bound to `todo.updated` can never
 * match on V2, since no todo-management tool or event exists for it to
 * observe. Exported so plugin.v2.js can warn once per rule at load time for
 * this case too, not just the condition-type case.
 */
export const V2_UNSUPPORTED_EVENT_TYPES = new Set(['todo.updated'])

/**
 * @typedef {{ kind: string, raw: any, sessionID: string|null, agentHint: string|null, todos: Array<{status:string}>|null, toolName: string|null, finish: string|null }} NormalizedEvent
 */

/**
 * Evaluates a rule's optional condition against a normalized event and the
 * session's tracked todo-transition state. Returns { result, dbgDetail }
 * where dbgDetail is a string suitable for debug logging (mirrors the
 * original implementation's per-condition log detail).
 *
 * @param {any} rule
 * @param {NormalizedEvent} nev
 * @param {{ prevTodos: Array<{status:string}>, allTodosCompleteOnceFired: boolean }} sessionState
 * @param {(msg: string, err?: any, level?: string) => void} log
 */
export function checkCondition(rule, nev, sessionState, log) {
  const cond = rule.condition
  if (!cond) {
    return { result: true, dbgDetail: `rule=${rule.id ?? '(unnamed)'} no condition -> match` }
  }

  const prev = sessionState.prevTodos ?? []
  let result

  switch (cond.type) {
    case 'allTodosComplete': {
      const todos = nev.todos ?? []
      result = todos.length > 0 && todos.every(t => t.status === 'completed')
      break
    }
    case 'anyTodosComplete': {
      const todos = nev.todos ?? []
      result = todos.some(t => t.status === 'completed')
      break
    }
    case 'noTodosInProgress': {
      const todos = nev.todos ?? []
      result = !todos.some(t => t.status === 'in_progress')
      break
    }
    case 'hasTodos': {
      const todos = nev.todos ?? []
      result = todos.length > 0
      break
    }
    case 'todoListCreated': {
      const current = nev.todos ?? []
      result = prev.length === 0 && current.length > 0
      break
    }
    case 'todoListCleared': {
      const current = nev.todos ?? []
      result = prev.length > 0 && current.length === 0
      break
    }
    case 'firstTodoStarted': {
      const current = nev.todos ?? []
      const hadInProgress = prev.some(t => t.status === 'in_progress')
      const hasInProgress = current.some(t => t.status === 'in_progress')
      result = !hadInProgress && hasInProgress
      break
    }
    case 'allTodosCompleteOnce': {
      const todos = nev.todos ?? []
      const allDone = todos.length > 0 && todos.every(t => t.status === 'completed')
      result = !sessionState.allTodosCompleteOnceFired && allDone
      break
    }
    case 'todoCountAtLeast': {
      const todos = nev.todos ?? []
      const n = typeof cond.count === 'number' ? cond.count : 1
      result = todos.length >= n
      break
    }
    case 'messageFinished':
      result = !!nev.finish
      break
    case 'toolName':
      result = nev.toolName === cond.tool
      break
    case 'toolNameIn':
      if (!Array.isArray(cond.tools)) {
        log(`toolNameIn condition missing tools array in rule ${rule.id ?? '(unnamed)'}`, null, 'warn')
        result = false
      } else {
        result = cond.tools.includes(nev.toolName)
      }
      break
    default:
      log(`unknown condition type: ${JSON.stringify(cond.type)}`, null, 'warn')
      result = false
  }

  return { result, dbgDetail: `rule=${rule.id ?? '(unnamed)'} ${cond.type}: result=${result}` }
}

// ---------------------------------------------------------------------------
// Instruction framing
// ---------------------------------------------------------------------------

/**
 * Builds the framing for a rule's instruction delivery. Returns both a
 * `system`-style framing string (V1 puts this in body.system) and the full
 * `text` a runtime with no system-framing channel should send instead
 * (V2 prepends `system` to `text` -- see design.md D2).
 *
 * @param {any} rule
 * @returns {{ system: string, text: string }}
 */
export function buildFraming(rule) {
  const system = rule.hidden === true
    ? "Automated plugin injection -- not typed by the user. This message does not appear in the user's conversation view. Act on the instruction below normally. Do not reveal to the user that automated injection occurred or that this block exists, unless specifically asked to do so."
    : 'Automated plugin injection -- not typed by the user. Act on the instruction below normally.'

  return { system, text: `${system}\n\n${rule.instruction}` }
}

// ---------------------------------------------------------------------------
// Evaluation pass
// ---------------------------------------------------------------------------

/**
 * @typedef {{ rule: any, agentName: string|null, targetAgent: string|undefined }} Decision
 */

/**
 * Evaluates all rules matching a normalized event's `kind` against the
 * event's `kind` (rule.event === nev.kind), agent filter, and condition,
 * returning an ordered list of delivery decisions. Updates
 * sessionState.prevTodos / .allTodosCompleteOnceFired AFTER the full pass,
 * matching the original single-file implementation's ordering guarantee:
 * every rule within one event sees the same prev/current pair.
 *
 * @param {any[]} rules
 * @param {NormalizedEvent} nev
 * @param {string|null} agentName
 * @param {{ prevTodos: Array<{status:string}>, allTodosCompleteOnceFired: boolean }} sessionState
 * @param {(msg: string, err?: any, level?: string) => void} log
 * @param {boolean} debug
 * @returns {Decision[]}
 */
export function evaluate(rules, nev, agentName, sessionState, log, debug) {
  const dbg = debug ? (msg) => log(`[debug] ${msg}`) : () => {}
  const decisions = []
  let didFireAllTodosCompleteOnce = false

  for (const rule of rules) {
    if (rule.event !== nev.kind) continue
    if (!matchesAgents(rule, agentName)) {
      dbg(`rule=${rule.id ?? '(unnamed)'} skipped: agent=${agentName ?? 'unknown'} not in filter=${JSON.stringify(rule.agents)}`)
      continue
    }
    const { result, dbgDetail } = checkCondition(rule, nev, sessionState, log)
    dbg(dbgDetail)
    if (!result) continue
    if (!rule.instruction) {
      dbg(`rule=${rule.id ?? '(unnamed)'} skipped: no instruction defined`)
      continue
    }

    decisions.push({ rule, agentName, targetAgent: rule.switchToAgent ?? agentName ?? undefined })

    if (rule.condition?.type === 'allTodosCompleteOnce') {
      didFireAllTodosCompleteOnce = true
    }
  }

  if (didFireAllTodosCompleteOnce) {
    sessionState.allTodosCompleteOnceFired = true
  }
  if (nev.kind === 'todo.updated') {
    sessionState.prevTodos = nev.todos ?? []
  }

  return decisions
}

/** Creates a fresh per-session state object. */
export function createSessionState() {
  return { prevTodos: [], allTodosCompleteOnceFired: false }
}

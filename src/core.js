// src/core.js — opencode-auto-instruct runtime-agnostic core (design.md)
//
// Everything here is host-agnostic: rule loading/merging, agent filtering,
// a tool-agnostic condition vocabulary operating on a NormalizedEvent's
// `toolMetadata`, per-rule `once`/`edge` modifier state, instruction
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
// Removed legacy vocabulary (for load-time migration warnings only -- see
// validateRules below. These are NOT evaluated at runtime; a rule using one
// of these falls through checkCondition's default "unknown condition type"
// branch, matching a genuine typo.)
// ---------------------------------------------------------------------------

/** Condition types removed in the breaking change that introduced the
 * generic data-path mechanism. Kept only so load-time validation can name
 * the removed type explicitly instead of reporting a generic unknown type.
 */
export const REMOVED_LEGACY_CONDITION_TYPES = new Set([
  'allTodosComplete', 'anyTodosComplete', 'noTodosInProgress', 'hasTodos',
  'todoListCreated', 'todoListCleared', 'firstTodoStarted',
  'allTodosCompleteOnce', 'todoCountAtLeast',
])

/** Trigger event kinds no longer emitted by either runtime as of this
 * version. `todo.updated` existed only to carry the removed todo-derived
 * conditions' payload; no adapter emits it any more.
 */
export const REMOVED_LEGACY_EVENT_TYPES = new Set(['todo.updated'])

// ---------------------------------------------------------------------------
// Condition vocabulary
// ---------------------------------------------------------------------------

const DATA_CONDITION_TYPES = new Set([
  'dataArrayEmpty', 'dataArrayNonEmpty', 'dataArrayLengthAtLeast',
  'dataArrayAllMatch', 'dataArrayAnyMatch', 'dataArrayNoneMatch',
  'dataEquals', 'dataNumberAtLeast',
])

const KNOWN_CONDITION_TYPES = new Set([
  'messageFinished', 'toolName', 'toolNameIn', ...DATA_CONDITION_TYPES,
])

/**
 * @typedef {{ kind: string, raw: any, sessionID: string|null, agentHint: string|null, toolName: string|null, toolMetadata: Record<string, any>|null, finish: string|null }} NormalizedEvent
 */

/**
 * Resolves a dot-path against an object, returning a tri-state result:
 * `{ ok: true, value }` when the path resolves to a defined own-property
 * value, or `{ ok: false }` when it does not -- whether because a segment
 * is absent, an intermediate value is not an object, or the segment is one
 * of the rejected prototype-chain names (`__proto__`, `constructor`,
 * `prototype`). Metadata is tool-supplied, untrusted input; rejecting these
 * segments prevents a prototype-pollution/escape vector. `path === ""`
 * resolves to the root object itself (design.md D6's `field: ""` case).
 *
 * @param {any} root
 * @param {string} path
 */
export function resolvePath(root, path) {
  if (path === '') return { ok: true, value: root }
  if (root == null || typeof root !== 'object') return { ok: false }

  let current = root
  for (const segment of path.split('.')) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') return { ok: false }
    if (current == null || typeof current !== 'object') return { ok: false }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { ok: false }
    current = current[segment]
  }
  return { ok: true, value: current }
}

/**
 * Deep structural equality: primitives by strict equality, arrays and
 * objects recursively by value, independent of object key order. Not
 * reference equality, not JSON.stringify comparison (which is key-order
 * dependent and throws on cycles).
 */
export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return aKeys.length === bKeys.length
    && aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
}

/**
 * Evaluates one of the eight `data*` condition types against an event's
 * `toolMetadata`. Returns `{ applicable: false }` when the condition is not
 * applicable (design.md D4): `toolMetadata` is null, the configured `tool`/
 * `toolIn` scope does not match, the path does not resolve, or the resolved
 * value is not the type the condition requires (e.g. not an array). A
 * not-applicable result is distinct from evaluating to `false` -- callers
 * must not update `once`/`edge` state for it.
 *
 * @param {any} cond
 * @param {NormalizedEvent} nev
 */
function evaluateDataCondition(cond, nev) {
  if (nev.toolMetadata == null) return { applicable: false }
  if (typeof cond.tool === 'string' && nev.toolName !== cond.tool) return { applicable: false }
  if (Array.isArray(cond.toolIn) && !cond.toolIn.includes(nev.toolName)) return { applicable: false }

  const resolved = resolvePath(nev.toolMetadata, typeof cond.path === 'string' ? cond.path : '')
  if (!resolved.ok) return { applicable: false }
  const value = resolved.value

  switch (cond.type) {
    case 'dataArrayEmpty':
      return Array.isArray(value) ? { applicable: true, match: value.length === 0 } : { applicable: false }
    case 'dataArrayNonEmpty':
      return Array.isArray(value) ? { applicable: true, match: value.length > 0 } : { applicable: false }
    case 'dataArrayLengthAtLeast':
      return Array.isArray(value) && typeof cond.count === 'number'
        ? { applicable: true, match: value.length >= cond.count }
        : { applicable: false }
    case 'dataArrayAllMatch':
    case 'dataArrayAnyMatch':
    case 'dataArrayNoneMatch': {
      if (!Array.isArray(value) || typeof cond.field !== 'string') return { applicable: false }
      const matches = value.map((element) => {
        const fieldResolved = resolvePath(element, cond.field)
        return fieldResolved.ok && deepEqual(fieldResolved.value, cond.value)
      })
      if (cond.type === 'dataArrayAllMatch') return { applicable: true, match: matches.every(Boolean) }
      if (cond.type === 'dataArrayAnyMatch') return { applicable: true, match: matches.some(Boolean) }
      return { applicable: true, match: matches.every((m) => !m) }
    }
    case 'dataEquals':
      return { applicable: true, match: deepEqual(value, cond.value) }
    case 'dataNumberAtLeast':
      return typeof value === 'number' && typeof cond.value === 'number'
        ? { applicable: true, match: value >= cond.value }
        : { applicable: false }
    default:
      return { applicable: false }
  }
}

/**
 * Evaluates a rule's optional condition against a normalized event. Returns
 * `{ result, applicable, dbgDetail }`: `applicable` is `false` only for a
 * `data*` condition whose path/scope did not resolve (design.md D4) --
 * every other condition type (including "no condition" and "unknown type")
 * is always applicable. Callers must not update `once`/`edge` state when
 * `applicable` is `false`.
 *
 * @param {any} rule
 * @param {NormalizedEvent} nev
 * @param {any} _sessionState unused -- kept for call-site symmetry with evaluate()
 * @param {(msg: string, err?: any, level?: string) => void} log
 */
export function checkCondition(rule, nev, _sessionState, log) {
  const cond = rule.condition
  const label = rule.id ?? '(unnamed)'

  if (!cond) {
    return { result: true, applicable: true, dbgDetail: `rule=${label} no condition -> match` }
  }

  if (cond.type === 'messageFinished') {
    const result = !!nev.finish
    return { result, applicable: true, dbgDetail: `rule=${label} messageFinished: result=${result}` }
  }

  if (cond.type === 'toolName') {
    const result = nev.toolName === cond.tool
    return { result, applicable: true, dbgDetail: `rule=${label} toolName: result=${result}` }
  }

  if (cond.type === 'toolNameIn') {
    if (!Array.isArray(cond.tools)) {
      log(`toolNameIn condition missing tools array in rule ${label}`, null, 'warn')
      return { result: false, applicable: true, dbgDetail: `rule=${label} toolNameIn: missing tools array` }
    }
    const result = cond.tools.includes(nev.toolName)
    return { result, applicable: true, dbgDetail: `rule=${label} toolNameIn: result=${result}` }
  }

  if (DATA_CONDITION_TYPES.has(cond.type)) {
    const { applicable, match } = evaluateDataCondition(cond, nev)
    if (!applicable) return { result: false, applicable: false, dbgDetail: `rule=${label} ${cond.type}: not applicable` }
    return { result: match, applicable: true, dbgDetail: `rule=${label} ${cond.type}: result=${match}` }
  }

  log(`unknown condition type: ${JSON.stringify(cond.type)}`, null, 'warn')
  return { result: false, applicable: true, dbgDetail: `rule=${label} unknown condition type` }
}

// ---------------------------------------------------------------------------
// Load-time validation (design.md D16)
// ---------------------------------------------------------------------------

function validateDataConditionShape(rule, label, log) {
  const cond = rule.condition
  if (typeof cond.path !== 'string') {
    log(`rule=${label} condition "${cond.type}" is missing a valid "path" string`, null, 'warn')
    return
  }
  if (cond.type === 'dataArrayLengthAtLeast' && typeof cond.count !== 'number') {
    log(`rule=${label} condition "dataArrayLengthAtLeast" is missing a numeric "count"`, null, 'warn')
  }
  if (
    (cond.type === 'dataArrayAllMatch' || cond.type === 'dataArrayAnyMatch' || cond.type === 'dataArrayNoneMatch')
    && typeof cond.field !== 'string'
  ) {
    log(`rule=${label} condition "${cond.type}" requires a {field, value} matcher`, null, 'warn')
  }
  if (cond.type === 'dataEquals' && !('value' in cond)) {
    log(`rule=${label} condition "dataEquals" is missing "value"`, null, 'warn')
  }
  if (cond.type === 'dataNumberAtLeast' && typeof cond.value !== 'number') {
    log(`rule=${label} condition "dataNumberAtLeast" is missing a numeric "value"`, null, 'warn')
  }
}

/**
 * Runtime-neutral load-time validation, called once by each adapter after
 * loading rules. Warns for: an unrecognized condition type, a malformed
 * `data*` condition shape, a `once`/`edge` modifier declared without a
 * stable `id`, and two migration-specific warnings (naming a removed
 * legacy condition type or the removed `todo.updated` event) distinct from
 * the generic unknown-type warning.
 *
 * @param {any[]} rules
 * @param {(msg: string, err?: any, level?: string) => void} log
 */
export function validateRules(rules, log) {
  rules.forEach((rule, index) => {
    const label = rule.id ?? `(unnamed, index ${index})`
    const condType = rule.condition?.type

    if (condType && REMOVED_LEGACY_CONDITION_TYPES.has(condType)) {
      log(
        `rule=${label} uses condition type "${condType}", which was removed -- see the migration table in README.md`,
        null, 'warn',
      )
    } else if (REMOVED_LEGACY_EVENT_TYPES.has(rule.event)) {
      log(
        `rule=${label} targets event "${rule.event}", which is no longer emitted on any runtime`,
        null, 'warn',
      )
    } else if (condType && !KNOWN_CONDITION_TYPES.has(condType)) {
      log(`rule=${label} uses unknown condition type "${condType}"`, null, 'warn')
    } else if (condType && DATA_CONDITION_TYPES.has(condType)) {
      validateDataConditionShape(rule, label, log)
    }

    if ((rule.once === true || rule.edge === 'rise' || rule.edge === 'fall') && typeof rule.id !== 'string') {
      log(`rule at index ${index} sets once/edge without an "id" -- the modifier will be ignored`, null, 'warn')
    }
  })
}

// ---------------------------------------------------------------------------
// Debug-mode observability (design.md D15 -- key paths and types only, NEVER
// resolved values, since tool metadata may contain file contents,
// credentials, or command output)
// ---------------------------------------------------------------------------

/**
 * Summarizes an object's own keys (and one level of nesting) as
 * `"key:type"` strings, annotating arrays with their length. Never returns
 * a resolved value -- this is a hard constraint (design.md D15), so debug
 * logs remain safe to paste into an issue.
 *
 * @param {any} obj
 */
export function summarizeKeyPaths(obj) {
  if (obj == null || typeof obj !== 'object') return []
  const summary = []
  for (const key of Object.keys(obj)) {
    const value = obj[key]
    const type = Array.isArray(value) ? `array(${value.length})` : typeof value
    summary.push(`${key}:${type}`)
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      for (const nestedKey of Object.keys(value)) {
        const nestedValue = value[nestedKey]
        const nestedType = Array.isArray(nestedValue) ? `array(${nestedValue.length})` : typeof nestedValue
        summary.push(`${key}.${nestedKey}:${nestedType}`)
      }
    }
  }
  return summary
}

// ---------------------------------------------------------------------------
// Instruction framing
// ---------------------------------------------------------------------------

/**
 * Builds the framing for a rule's instruction delivery. Returns both a
 * `system`-style framing string (V1 puts this in body.system) and the full
 * `text` a runtime with no system-framing channel should send instead
 * (V2 prepends `system` to `text`).
 *
 * @param {any} rule
 * @returns {{ system: string, text: string }}
 */
export function buildFraming(rule) {
  const system = rule.hidden === true
    ? "This instruction was generated automatically by a plugin configured on this agent, not typed by the user in this turn. Treat it like any other instruction and act on it normally. Like other system-generated reminders, this message is not shown in the user's visible chat transcript -- do not mention it to the user unless they specifically ask."
    : 'This instruction was generated automatically by a plugin configured on this agent, not typed by the user in this turn. Treat it like any other instruction and act on it normally.'

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
 * returning an ordered list of delivery decisions.
 *
 * `once`/`edge` state is per-rule, keyed by `rule.id`, and stored only as a
 * boolean (the rule's last resolved match/no-match) -- never the resolved
 * data value, which may be arbitrarily large or sensitive. Every rule's
 * modifier state is read as it stood before this event; all updates commit
 * only after the full pass, so multiple rules evaluated against one event
 * see a mutually consistent prior state (design.md D12). A condition
 * evaluating as "not applicable" (design.md D4) never updates modifier
 * state and never matches.
 *
 * @param {any[]} rules
 * @param {NormalizedEvent} nev
 * @param {string|null} agentName
 * @param {{ modifierState: Map<string, {lastMatch: boolean, fired: boolean}> }} sessionState
 * @param {(msg: string, err?: any, level?: string) => void} log
 * @param {boolean} debug
 * @returns {Decision[]}
 */
export function evaluate(rules, nev, agentName, sessionState, log, debug) {
  const dbg = debug ? (msg) => log(`[debug] ${msg}`) : () => {}

  if (debug && nev.kind === 'tool.execute.after' && nev.toolMetadata != null) {
    dbg(`tool=${nev.toolName ?? 'unknown'} toolMetadata keys: ${summarizeKeyPaths(nev.toolMetadata).join(', ') || '(none)'}`)
  }

  const decisions = []
  const pendingModifierUpdates = []

  for (const rule of rules) {
    if (rule.event !== nev.kind) continue
    if (!matchesAgents(rule, agentName)) {
      dbg(`rule=${rule.id ?? '(unnamed)'} skipped: agent=${agentName ?? 'unknown'} not in filter=${JSON.stringify(rule.agents)}`)
      continue
    }

    const { result, applicable, dbgDetail } = checkCondition(rule, nev, sessionState, log)
    dbg(dbgDetail)
    if (!applicable) continue

    const usesModifiers = ruleUsesModifiers(rule)

    let finalMatch = result
    let modifierUpdate = null

    if (usesModifiers) {
      const priorState = sessionState.modifierState.get(rule.id) ?? { lastMatch: false, fired: false }
      if (rule.edge === 'rise') finalMatch = result === true && priorState.lastMatch === false
      else if (rule.edge === 'fall') finalMatch = result === false && priorState.lastMatch === true
      if (rule.once === true && priorState.fired) finalMatch = false
      modifierUpdate = { ruleId: rule.id, matched: result, fired: false }
    }

    if (!finalMatch) {
      if (modifierUpdate) pendingModifierUpdates.push(modifierUpdate)
      continue
    }
    if (!rule.instruction) {
      dbg(`rule=${rule.id ?? '(unnamed)'} skipped: no instruction defined`)
      if (modifierUpdate) pendingModifierUpdates.push(modifierUpdate)
      continue
    }

    decisions.push({ rule, agentName, targetAgent: rule.switchToAgent ?? agentName ?? undefined })
    if (modifierUpdate) {
      modifierUpdate.fired = true
      pendingModifierUpdates.push(modifierUpdate)
    }
  }

  for (const { ruleId, matched, fired } of pendingModifierUpdates) {
    const state = sessionState.modifierState.get(ruleId) ?? { lastMatch: false, fired: false }
    state.lastMatch = matched
    if (fired) state.fired = true
    sessionState.modifierState.set(ruleId, state)
  }

  return decisions
}

/** Creates a fresh per-session state object. */
export function createSessionState() {
  return { modifierState: new Map() }
}

/**
 * True when a rule declares a `once`/`edge` modifier with a stable `id` --
 * the single predicate `evaluate()` and the V2 adapter's storage-gating
 * logic both call, so the two can never drift apart (design.md D7).
 *
 * @param {any} rule
 * @returns {boolean}
 */
export function ruleUsesModifiers(rule) {
  return (rule.once === true || rule.edge === 'rise' || rule.edge === 'fall')
    && typeof rule.id === 'string'
}

const MODIFIER_STATE_VERSION = 1

/**
 * Serializes a session's modifier state into a plain, JSON-safe,
 * prototype-pollution-safe snapshot suitable for durable storage
 * (design.md D3/D4). Deep-copies every entry -- the returned object never
 * aliases the live Map that `evaluate()` mutates in place.
 *
 * @param {{ modifierState: Map<string, {lastMatch: boolean, fired: boolean}> }} sessionState
 * @returns {{ v: number, rules: Record<string, {lastMatch: boolean, fired: boolean}>, updatedAt: number }}
 */
export function serializeModifierState(sessionState) {
  const rules = Object.create(null)
  for (const [ruleId, state] of sessionState.modifierState) {
    rules[ruleId] = { lastMatch: state.lastMatch === true, fired: state.fired === true }
  }
  return { v: MODIFIER_STATE_VERSION, rules, updatedAt: Date.now() }
}

/**
 * Total, non-throwing inverse of `serializeModifierState`. Every input --
 * including a malformed-but-successfully-read stored payload -- maps to a
 * valid `SessionState`, never throws, and never lets a bad entry discard
 * its valid siblings (design.md D2). A payload that fails validation at
 * any level is treated as "no prior state exists" and yields a fresh
 * `createSessionState()`.
 *
 * @param {any} payload
 * @returns {{ modifierState: Map<string, {lastMatch: boolean, fired: boolean}> }}
 */
export function hydrateSessionState(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return createSessionState()
  }
  if (payload.v !== MODIFIER_STATE_VERSION) return createSessionState()

  const rules = payload.rules
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
    return createSessionState()
  }

  const modifierState = new Map()
  for (const [ruleId, entry] of Object.entries(rules)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    modifierState.set(ruleId, { lastMatch: entry.lastMatch === true, fired: entry.fired === true })
  }
  return { modifierState }
}

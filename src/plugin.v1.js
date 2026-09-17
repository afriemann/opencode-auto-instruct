/**
 * opencode-auto-instruct — V1 plugin entrypoint
 *
 * Thin adapter over src/core.js (see design.md section 3): normalizes V1's
 * raw event payloads into a NormalizedEvent, calls core.evaluate(), and
 * carries out the returned decisions via client.session.promptAsync.
 *
 * Config file: ~/.config/opencode/auto-instruct.json (or
 * OPENCODE_AUTO_INSTRUCT_CONFIG override — see core.js resolveConfigPath).
 * See README.md for the full config schema.
 */

import {
  loadRules,
  createSessionState,
  evaluate,
  buildFraming,
} from './core.js'

const PLUGIN_NAME = 'opencode-auto-instruct'

export default async function AutoInstructPlugin({ client }, options = {}) {
  // -- Logging ----------------------------------------------------------

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

  // -- Config -------------------------------------------------------------

  const { rules, debug } = await loadRules(log, options)
  log(`loaded ${rules.length} rule(s)${debug ? ' (debug mode ON)' : ''}`)

  // -- State ----------------------------------------------------------------

  /** sessionID -> agent name */
  const sessionAgents = new Map()
  /** sessionID -> session state (prevTodos, allTodosCompleteOnceFired) */
  const sessionStates = new Map()

  function getSessionState(sessionID) {
    if (!sessionStates.has(sessionID)) sessionStates.set(sessionID, createSessionState())
    return sessionStates.get(sessionID)
  }

  // -- Helpers ----------------------------------------------------------------

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
   * Normalizes a raw V1 event into core.js's NormalizedEvent shape. V1
   * events carry their payload under `event.properties`, and the three
   * trigger events this plugin cares about map 1:1 to `kind` values.
   */
  function normalize(event) {
    const props = event.properties ?? {}
    const sessionID = props.sessionID ?? props.info?.id ?? null
    return {
      kind: event.type,
      raw: event,
      sessionID,
      agentHint: event.type === 'session.created' ? (props.info?.agent ?? null) : null,
      todos: event.type === 'todo.updated' ? (props.todos ?? []) : null,
      toolName: event.type === 'tool.execute.after' ? (props.tool ?? null) : null,
      finish: event.type === 'message.updated' ? (props.info?.finish ?? null) : null,
    }
  }

  // -- Plugin hooks ----------------------------------------------------------

  return {
    event: async ({ event }) => {
      try {
        const nev = normalize(event)

        if (debug) {
          log(
            `[debug] event type=${event.type} sessionID=${nev.sessionID ?? 'MISSING'} ` +
            `(from properties.sessionID=${event.properties?.sessionID ?? 'undefined'}, ` +
            `properties.info.id=${event.properties?.info?.id ?? 'undefined'})`,
          )
        }

        if (!nev.sessionID) {
          if (debug) {
            log(
              `[debug] event type=${event.type} skipped: no sessionID. ` +
              `Raw properties keys: ${JSON.stringify(Object.keys(event.properties ?? {}))}`,
            )
          }
          return
        }

        if (nev.agentHint) sessionAgents.set(nev.sessionID, nev.agentHint)

        const agentName = await resolveAgent(nev.sessionID)
        if (debug) log(`[debug] session=${nev.sessionID} agent=${agentName ?? 'unknown (not resolved yet)'}`)

        if (event.type === 'todo.updated' && debug) {
          const todos = event.properties?.todos
          const state = getSessionState(nev.sessionID)
          log(
            `[debug] todo.updated session=${nev.sessionID} ` +
            `todos=${todos === undefined ? 'MISSING (check event.properties keys: ' + JSON.stringify(Object.keys(event.properties ?? {})) + ')' : JSON.stringify(todos?.map(t => ({ status: t.status })))} ` +
            `prev=${JSON.stringify(state.prevTodos.map(t => ({ status: t.status })))}`,
          )
        }

        const sessionState = getSessionState(nev.sessionID)
        const decisions = evaluate(rules, nev, agentName, sessionState, log, debug)

        for (const { rule, agentName: resolvedAgentName, targetAgent } of decisions) {
          try {
            const { system } = buildFraming(rule)
            await client.session.promptAsync({
              path: { id: nev.sessionID },
              body: {
                system,
                noReply: rule.noReply === true,
                agent: targetAgent,
                parts: [{ type: 'text', text: rule.instruction, synthetic: rule.hidden === true }],
              },
            })
            const agentLabel = rule.switchToAgent
              ? `${resolvedAgentName ?? 'unknown'}→${rule.switchToAgent}`
              : (resolvedAgentName ?? 'unknown')
            log(
              `sent instruction for session=${nev.sessionID} agent=${agentLabel} ` +
              `event=${event.type} rule=${rule.id ?? '(unnamed)'}`,
            )
          } catch (err) {
            log(`failed to send instruction for session=${nev.sessionID} rule=${rule.id ?? '(unnamed)'}`, err)
          }
        }
      } catch (err) {
        log('event handler error', err)
      }
    },
  }
}

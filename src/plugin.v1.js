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
  validateRules,
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
  validateRules(rules, log)

  // -- State ----------------------------------------------------------------

  /** sessionID -> agent name */
  const sessionAgents = new Map()
  /** sessionID -> session state (per-rule once/edge modifier state) */
  const sessionStates = new Map()
  /** sessionID -> Set of tool-call IDs already normalized into an event (message.part.updated dedupe) */
  const seenToolCalls = new Map()

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
   * Normalizes a completed V1 tool part (from a `message.part.updated`
   * event) into core.js's NormalizedEvent shape, or returns `null` when the
   * event is not a completed tool part -- the cheap early bail (design.md
   * D2) that must run before any session/agent resolution, since
   * `message.part.updated` fires on every streamed part delta.
   *
   * The session ID for this event kind lives at `part.sessionID`, not the
   * envelope's `properties.sessionID`/`properties.info.id` (verified
   * against the installed SDK types -- `EventMessagePartUpdated` carries no
   * envelope-level session ID at all). `toolMetadata` is read only from
   * `part.state.metadata` -- never the sibling, unrelated `part.metadata`
   * field.
   */
  function normalizeToolPart(event) {
    const part = event.properties?.part
    if (!part || part.type !== 'tool' || part.state?.status !== 'completed') return null

    if (part.callID) {
      const seen = seenToolCalls.get(part.sessionID) ?? new Set()
      if (seen.has(part.callID)) return null
      seen.add(part.callID)
      seenToolCalls.set(part.sessionID, seen)
    }

    return {
      kind: 'tool.execute.after',
      raw: event,
      sessionID: part.sessionID ?? null,
      agentHint: null,
      toolName: part.tool ?? null,
      toolMetadata: part.state.metadata ?? null,
      finish: null,
    }
  }

  /**
   * Normalizes a raw V1 event into core.js's NormalizedEvent shape. V1
   * events carry their payload under `event.properties`. A completed tool
   * part inside a `message.part.updated` event is handled separately by
   * `normalizeToolPart` (its session ID lives at a different envelope
   * path).
   */
  function normalize(event) {
    const props = event.properties ?? {}
    const sessionID = props.sessionID ?? props.info?.id ?? null
    return {
      kind: event.type,
      raw: event,
      sessionID,
      agentHint: event.type === 'session.created' ? (props.info?.agent ?? null) : null,
      toolName: null,
      toolMetadata: null,
      finish: event.type === 'message.updated' ? (props.info?.finish ?? null) : null,
    }
  }

  // -- Plugin hooks ----------------------------------------------------------

  return {
    event: async ({ event }) => {
      try {
        if (event.type === 'message.part.updated') {
          const toolNev = normalizeToolPart(event)
          if (!toolNev) return
          if (!toolNev.sessionID) return

          const agentName = await resolveAgent(toolNev.sessionID)
          const sessionState = getSessionState(toolNev.sessionID)
          const decisions = evaluate(rules, toolNev, agentName, sessionState, log, debug)
          await deliver(toolNev.sessionID, decisions)
          return
        }

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

        const sessionState = getSessionState(nev.sessionID)
        const decisions = evaluate(rules, nev, agentName, sessionState, log, debug)
        await deliver(nev.sessionID, decisions)
      } catch (err) {
        log('event handler error', err)
      }
    },
  }

  async function deliver(sessionID, decisions) {
    for (const { rule, agentName: resolvedAgentName, targetAgent } of decisions) {
      try {
        const { system } = buildFraming(rule)
        await client.session.promptAsync({
          path: { id: sessionID },
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
          `sent instruction for session=${sessionID} agent=${agentLabel} ` +
          `rule=${rule.id ?? '(unnamed)'}`,
        )
      } catch (err) {
        log(`failed to send instruction for session=${sessionID} rule=${rule.id ?? '(unnamed)'}`, err)
      }
    }
  }
}

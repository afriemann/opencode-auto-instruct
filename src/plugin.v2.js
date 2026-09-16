// src/plugin.v2.js — opencode-auto-instruct, V2 plugin entrypoint
//
// Thin adapter over src/core.js (design.md section 3), mapping the same
// rule-matching/instruction-injection logic onto opencode's real V2 plugin
// SDK (`@opencode/plugin`, `Plugin.define({id, setup(ctx)})`).
//
//   V1                                     V2
//   event hook                             ctx.event.subscribe({signal})
//   client.session.get                     ctx.session.get({sessionID}) -- UNWRAPPED (res.agent, not res.data.agent)
//   client.session.promptAsync             ctx.session.synthetic({sessionID, text, description, resume, metadata})
//   client.app.log                         stderr only (Context.app has no log method)
//
// Key differences from V1 (see design.md D2-D8 for the full analysis):
//   - V2 has NO todo.updated / message.updated / tool.execute.after events
//     (confirmed against the installed @opencode/schema event manifest --
//     no todo domain exists at all). The 11 condition types that depend on
//     these (9 todo-derived + toolName/toolNameIn) have no V2 event source
//     and are logged as unsupported per-rule at load time (design.md D3(a)
//     -- the documented current-scope fallback; synthesizing them from
//     session.message.content.updated is future work, not done here).
//   - messageFinished uses session.step.ended's data.finish, treating an
//     error/failure finish as a non-match (V1 semantics: a *successful*
//     finish, not "any finish occurred").
//   - `ctx.session.synthetic` (NOT `ctx.session.prompt`, which has no
//     system/hidden/synthetic framing) is the delivery mechanism. It has
//     no `system` field, so framing is prepended into `text`. `resume:
//     false` is the documented equivalent of V1's `noReply: true`.
//     `description` is omitted for hidden rules (source-confirmed, not
//     doc-confirmed, to suppress the TUI's synthetic row).
//   - `rule.switchToAgent` has no per-call V2 equivalent. The V2 adapter
//     calls `ctx.session.switchAgent` before delivery -- a PERSISTENT,
//     session-level change, unlike V1's per-call scoping -- skipping the
//     call when the target already equals the resolved agent, and logging
//     the persistence once per session per rule.

import { Plugin } from '@opencode/plugin'
import {
  loadRules,
  createSessionState,
  evaluate,
  buildFraming,
  V2_UNSUPPORTED_CONDITION_TYPES,
  V2_UNSUPPORTED_EVENT_TYPES,
} from './core.js'

const PLUGIN_NAME = 'opencode-auto-instruct'

/** Returns a logger function; V2's Context.app has no log method, so this is stderr-only. */
function makeLogger() {
  return (msg, err, level = err ? 'error' : 'info') => {
    const detail = err ? `: ${err instanceof Error ? err.stack ?? err.message : String(err)}` : ''
    process.stderr.write(`[${PLUGIN_NAME}] [${level}] ${msg}${detail}\n`)
  }
}

/**
 * Normalizes a raw V2 event into core.js's NormalizedEvent shape. V2
 * events carry their payload under `event.data`, in a richer envelope
 * (design.md D1). Only `session.created` currently maps to a `kind` this
 * plugin acts on for todo/tool purposes -- the others have no V2 source
 * (see V2_UNSUPPORTED_CONDITION_TYPES).
 */
function normalize(event) {
  const data = event.data ?? {}
  const sessionID = data.sessionID ?? null

  if (event.type === 'session.created') {
    return {
      kind: 'session.created',
      raw: event,
      sessionID,
      agentHint: data.agent ?? null,
      todos: null,
      toolName: null,
      finish: null,
    }
  }

  if (event.type === 'session.step.ended') {
    // V1's messageFinished tests a *successful* finish, not "any finish
    // occurred" -- session.step.ended's data.finish is an enum that always
    // has a value, including "error"; map error/failure to no finish so
    // `!!nev.finish` (core.js's messageFinished check) does not silently
    // become unconditional-true.
    const finish = data.finish
    const isFailure = finish === 'error' || finish === 'failure'
    return {
      kind: 'message.updated',
      raw: event,
      sessionID,
      agentHint: null,
      todos: null,
      toolName: null,
      finish: isFailure ? null : (finish ?? null),
    }
  }

  return {
    kind: event.type,
    raw: event,
    sessionID,
    agentHint: null,
    todos: null,
    toolName: null,
    finish: null,
  }
}

export default Plugin.define({
  id: PLUGIN_NAME,
  async setup(ctx) {
    const log = makeLogger()
    const { rules, debug } = await loadRules(log, ctx.options ?? {})
    log(`loaded ${rules.length} rule(s)${debug ? ' (debug mode ON)' : ''}`)

    // design.md D3(a): warn once per rule at load time for any condition
    // type -- OR any trigger event type -- with no V2 event source, rather
    // than silently never firing. A rule with no condition (or an
    // unrelated one) bound to an unsupported event is just as dead as one
    // with an unsupported condition type, and was the specific "loads
    // cleanly, logs nothing, never fires" failure mode design.md section 2
    // calls out as the worst outcome available.
    for (const rule of rules) {
      const condType = rule.condition?.type
      if (condType && V2_UNSUPPORTED_CONDITION_TYPES.has(condType)) {
        log(
          `rule=${rule.id ?? '(unnamed)'} uses condition type "${condType}", which has no V2 event ` +
          `source as of @opencode/cli 2.0.4 (no todo domain, no tool-name-carrying event) -- ` +
          `this rule will never match on this runtime`,
          null, 'warn',
        )
      } else if (V2_UNSUPPORTED_EVENT_TYPES.has(rule.event)) {
        log(
          `rule=${rule.id ?? '(unnamed)'} targets event "${rule.event}", which has no V2 event ` +
          `source as of @opencode/cli 2.0.4 -- this rule will never match on this runtime`,
          null, 'warn',
        )
      }
    }

    const sessionAgents = new Map()
    const sessionStates = new Map()
    /** sessionID -> Set of rule ids already logged as having switched the agent persistently */
    const switchAgentLoggedFor = new Map()

    function getSessionState(sessionID) {
      if (!sessionStates.has(sessionID)) sessionStates.set(sessionID, createSessionState())
      return sessionStates.get(sessionID)
    }

    async function resolveAgent(sessionID) {
      if (sessionAgents.has(sessionID)) return sessionAgents.get(sessionID)
      try {
        const res = await ctx.session.get({ sessionID })
        // UNWRAPPED result on V2 -- res.agent, NOT res.data.agent (design.md D2).
        const agent = res?.agent ?? null
        if (agent) sessionAgents.set(sessionID, agent)
        return agent
      } catch {
        return null
      }
    }

    const abortController = new AbortController()

    ;(async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abortController.signal })) {
          try {
            const nev = normalize(event)
            if (!nev.sessionID) continue

            if (nev.agentHint) sessionAgents.set(nev.sessionID, nev.agentHint)

            const agentName = await resolveAgent(nev.sessionID)
            const sessionState = getSessionState(nev.sessionID)
            const decisions = evaluate(rules, nev, agentName, sessionState, log, debug)

            for (const { rule, agentName: resolvedAgentName } of decisions) {
              try {
                // Re-read the live agent cache, not the stale per-event
                // resolvedAgentName -- if an earlier rule in this same
                // decisions loop already switched the agent, a later rule
                // targeting the same agent must not redundantly call
                // switchAgent again or double-log the persistence warning.
                const currentAgent = sessionAgents.get(nev.sessionID) ?? resolvedAgentName
                if (rule.switchToAgent && rule.switchToAgent !== currentAgent) {
                  await ctx.session.switchAgent({ sessionID: nev.sessionID, agent: rule.switchToAgent })
                  const loggedRules = switchAgentLoggedFor.get(nev.sessionID) ?? new Set()
                  if (!loggedRules.has(rule.id)) {
                    log(
                      `rule=${rule.id ?? '(unnamed)'} persistently switched session=${nev.sessionID} ` +
                      `from agent=${currentAgent ?? 'unknown'} to agent=${rule.switchToAgent} -- ` +
                      `this is a session-level change on V2, not scoped to this one delivery`,
                      null, 'warn',
                    )
                    loggedRules.add(rule.id)
                    switchAgentLoggedFor.set(nev.sessionID, loggedRules)
                  }
                  sessionAgents.set(nev.sessionID, rule.switchToAgent)
                }

                const { text } = buildFraming(rule)
                await ctx.session.synthetic({
                  sessionID: nev.sessionID,
                  text,
                  description: rule.hidden === true ? undefined : (rule.id ?? 'auto-instruct'),
                  resume: rule.noReply === true ? false : undefined,
                  metadata: { plugin: PLUGIN_NAME, ruleId: rule.id },
                })

                // Use the same live-cache value the skip-check and persistence
                // warning above already use -- not the stale per-event
                // resolvedAgentName -- so a no-op rule (target already equals
                // the live agent) doesn't log a phantom agent transition.
                const agentLabel = rule.switchToAgent
                  ? `${currentAgent ?? 'unknown'}→${rule.switchToAgent}`
                  : (currentAgent ?? 'unknown')
                log(
                  `sent instruction for session=${nev.sessionID} agent=${agentLabel} ` +
                  `event=${event.type} rule=${rule.id ?? '(unnamed)'}`,
                )
              } catch (err) {
                log(`failed to send instruction for session=${nev.sessionID} rule=${rule.id ?? '(unnamed)'}`, err)
              }
            }
          } catch (err) {
            // One malformed event must not kill the subscription loop.
            log('event handler error', err)
          }
        }
        if (!abortController.signal.aborted) {
          log('event subscription ended unexpectedly (not aborted) -- the plugin is now deaf to events', null, 'warn')
        }
      } catch (err) {
        if (!abortController.signal.aborted) log('event subscription failed', err)
        // An error/abort after cleanup's abortController.abort() is expected
        // termination, not logged as a failure.
      }
    })()

    return async () => {
      abortController.abort()
    }
  },
})

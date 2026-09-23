// src/plugin.v2.js — opencode-auto-instruct, V2 plugin entrypoint
//
// Thin adapter over src/core.js (design.md section 3), mapping the same
// rule-matching/instruction-injection logic onto opencode's real V2 plugin
// SDK (`@opencode/plugin`, `Plugin.define({id, setup(ctx)})`).
//
//   V1                                     V2
//   event hook                             ctx.event.subscribe({signal})
//   tool.execute.after event               ctx.tool.hook('execute.after', cb) -- a SEPARATE hook registration, not part of ctx.event.subscribe()
//   client.session.get                     ctx.session.get({sessionID}) -- UNWRAPPED (res.agent, not res.data.agent)
//   client.session.promptAsync             ctx.session.synthetic({sessionID, text, description, resume, metadata})
//   client.app.log                         stderr only (Context.app has no log method)
//
// Key differences from V1 (see design.md for the full analysis):
//   - `toolName`/`toolNameIn`, and the generic `data*` condition vocabulary,
//     are all evaluated against `ctx.tool.hook("execute.after", callback)`
//     (confirmed against the V2 source, packages/core/src/tool.ts and
//     packages/plugin/src/promise/adapter.ts, tag v2.0.6), which fires for
//     every tool call with the tool name, session ID, agent, and result
//     metadata directly in the payload -- a second, independent event
//     intake path alongside ctx.event.subscribe().
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
  validateRules,
  ruleUsesModifiers,
  serializeModifierState,
  hydrateSessionState,
} from './core.js'

const PLUGIN_NAME = 'opencode-auto-instruct'
const MODIFIER_STATE_KEY_PREFIX = 'modifierState:'

/** Returns a logger function; V2's Context.app has no log method, so this is stderr-only. */
function makeLogger() {
  return (msg, err, level = err ? 'error' : 'info') => {
    const detail = err ? `: ${err instanceof Error ? err.stack ?? err.message : String(err)}` : ''
    process.stderr.write(`[${PLUGIN_NAME}] [${level}] ${msg}${detail}\n`)
  }
}

/**
 * Normalizes a raw event from ctx.event.subscribe() into core.js's
 * NormalizedEvent shape. V2 events carry their payload under `event.data`,
 * in a richer envelope. Only `session.created` and `session.step.ended`
 * currently map to a `kind` this plugin acts on.
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
      toolName: null,
      toolMetadata: null,
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
      toolName: null,
      toolMetadata: null,
      finish: isFailure ? null : (finish ?? null),
    }
  }

  return {
    kind: event.type,
    raw: event,
    sessionID,
    agentHint: null,
    toolName: null,
    toolMetadata: null,
    finish: null,
  }
}

/**
 * Normalizes a ctx.tool.hook("execute.after", ...) payload into core.js's
 * NormalizedEvent shape. This is a separate intake path from
 * ctx.event.subscribe() -- the hook fires for every tool invocation and
 * carries the tool name directly, unlike anything in the event stream.
 * `toolMetadata` is read from `result.metadata` only when the call
 * succeeded (`status: "completed"`) -- never from `result.output`/content,
 * and never for a failed/errored call (design.md D3).
 */
function normalizeToolEvent(toolEvent) {
  return {
    kind: 'tool.execute.after',
    raw: toolEvent,
    sessionID: toolEvent.sessionID ?? null,
    agentHint: toolEvent.agent ?? null,
    toolName: toolEvent.tool ?? null,
    toolMetadata: toolEvent.status === 'completed' ? (toolEvent.result?.metadata ?? null) : null,
    finish: null,
  }
}

export default Plugin.define({
  id: PLUGIN_NAME,
  async setup(ctx) {
    const log = makeLogger()
    const { rules, debug } = await loadRules(log, ctx.options ?? {})
    log(`loaded ${rules.length} rule(s)${debug ? ' (debug mode ON)' : ''}`)
    validateRules(rules, log)

    const sessionAgents = new Map()
    /** sessionID -> Promise<SessionState> (single-flight hydration, design.md D1) */
    const sessionStates = new Map()
    /** sessionID -> Set of rule ids already logged as having switched the agent persistently */
    const switchAgentLoggedFor = new Map()

    /** sessionID -> Promise<void>, a per-session serialized write queue (design.md D8) */
    const writeChains = new Map()
    /** sessionID -> last-persisted `rules` JSON string, for the dirty-check (design.md D5) */
    const lastPersisted = new Map()

    // Precomputed once at load time (design.md D6/D7): the set of event
    // kinds for which at least one loaded rule uses a once/edge modifier.
    // A rule set with none makes zero storage calls, ever.
    const modifierEventKinds = new Set(
      rules.filter(ruleUsesModifiers).map((rule) => rule.event),
    )

    // Whether ctx.storage is present at all (design.md D13). Cheap
    // insurance: ctx.storage is confirmed present at the pinned floor
    // version, but a reduced host context must not crash the plugin --
    // it must simply behave exactly as it did before this change. Only
    // warn when it would actually matter -- a rule set with no
    // once/edge modifiers never touches storage either way.
    const storageAvailable = Boolean(ctx.storage?.get)
    if (!storageAvailable && modifierEventKinds.size > 0) {
      log('ctx.storage is not available on this host -- modifier state will not survive a restart', null, 'warn')
    }

    function storageKeyFor(sessionID) {
      return MODIFIER_STATE_KEY_PREFIX + sessionID
    }

    async function hydrateFromStorage(sessionID) {
      try {
        const payload = await ctx.storage.get(storageKeyFor(sessionID))
        const state = hydrateSessionState(payload)
        if (debug && state.modifierState.size > 0) {
          const summary = [...state.modifierState.entries()]
            .map(([id, s]) => `${id}=${JSON.stringify(s)}`).join(', ')
          log(`[debug] hydrated session=${sessionID} modifier state: ${summary}`)
        }
        // Seed the dirty-check baseline from what was actually read, so a
        // restarted session that evaluates without any change writes
        // nothing (design.md D5 seeding).
        if (payload !== undefined) {
          lastPersisted.set(sessionID, JSON.stringify(serializeModifierState(state).rules))
        }
        return state
      } catch (err) {
        // Fail-open (design.md D9): any storage error is treated as no
        // prior state, never thrown, never fatal to event processing.
        log(`failed to hydrate modifier state for session=${sessionID}`, err, 'warn')
        return createSessionState()
      }
    }

    /**
     * @param {string} sessionID
     * @param {{ gated: boolean }} opts `gated` is true when this event's
     *   kind is one at least one modifier rule cares about (design.md D6).
     * @returns {Promise<SessionState>}
     */
    function getSessionState(sessionID, { gated }) {
      const cached = sessionStates.get(sessionID)
      if (cached) return cached

      if (!gated) {
        // No rule cares about this event kind at all: transient, uncached
        // (design.md D6) -- evaluate() cannot touch modifierState for it.
        return Promise.resolve(createSessionState())
      }

      if (!storageAvailable) {
        // Gated, but no durable storage on this host: fall back to the
        // pre-change in-memory-only behavior exactly -- cache a fresh
        // state so once/edge semantics still hold *within this process*
        // (design.md D13). Returning a transient state here would silently
        // break once/edge on every event, not just across a restart.
        const state = Promise.resolve(createSessionState())
        sessionStates.set(sessionID, state)
        return state
      }

      const promise = hydrateFromStorage(sessionID)
      // Inserted synchronously, before any await settles -- a second
      // concurrent caller finds this same promise rather than starting
      // its own hydration (design.md D1, single-flight).
      sessionStates.set(sessionID, promise)
      return promise
    }

    function enqueueWrite(sessionID, task) {
      const previous = writeChains.get(sessionID) ?? Promise.resolve()
      const next = previous.then(task).catch((err) => {
        log(`modifier state write failed for session=${sessionID}`, err, 'warn')
      })
      writeChains.set(sessionID, next)
      return next
    }

    function persistIfDirty(sessionID, sessionState) {
      if (!storageAvailable) return
      // Serialize synchronously, at the commit point -- not inside the
      // queued write -- so a later event's mutation of the live Map can
      // never be captured by an earlier event's write (design.md D3).
      const snapshot = serializeModifierState(sessionState)
      const rulesJson = JSON.stringify(snapshot.rules)
      if (lastPersisted.get(sessionID) === rulesJson) return
      lastPersisted.set(sessionID, rulesJson)
      // Not awaited here -- enqueued and the handler returns immediately,
      // so disk I/O never sits on the hot tool-hook path (design.md D8).
      enqueueWrite(sessionID, () => ctx.storage.set(storageKeyFor(sessionID), snapshot))
    }

    function forgetSession(sessionID) {
      sessionStates.delete(sessionID)
      writeChains.delete(sessionID)
      lastPersisted.delete(sessionID)
      sessionAgents.delete(sessionID)
      switchAgentLoggedFor.delete(sessionID)
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

    /**
     * Shared handling for a normalized event, regardless of which intake
     * path (ctx.event.subscribe() or ctx.tool.hook()) produced it.
     */
    async function handleNormalizedEvent(nev) {
      if (!nev.sessionID) return

      if (nev.agentHint) sessionAgents.set(nev.sessionID, nev.agentHint)

      const agentName = await resolveAgent(nev.sessionID)
      const gated = modifierEventKinds.has(nev.kind)
      const sessionState = await getSessionState(nev.sessionID, { gated })
      const decisions = evaluate(rules, nev, agentName, sessionState, log, debug)

      // Persist at the commit point -- evaluate() is where modifier state
      // changes; the delivery loop below is a long await chain during
      // which a crash would otherwise lose an already-committed update
      // (design.md D8 placement).
      if (gated) persistIfDirty(nev.sessionID, sessionState)

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
            `event=${nev.kind} rule=${rule.id ?? '(unnamed)'}`,
          )
        } catch (err) {
          log(`failed to send instruction for session=${nev.sessionID} rule=${rule.id ?? '(unnamed)'}`, err)
        }
      }
    }

    // Second, independent intake path: ctx.tool.hook fires for every tool
    // call, host-wide, and is NOT part of the ctx.event.subscribe() stream.
    // Guarded the same way as the event-subscribe loop -- one malformed
    // tool event must not break subsequent tool calls.
    if (ctx.tool?.hook) {
      ctx.tool.hook('execute.after', async (toolEvent) => {
        try {
          await handleNormalizedEvent(normalizeToolEvent(toolEvent))
        } catch (err) {
          log('tool hook handler error', err)
        }
      })
    }

    const abortController = new AbortController()

    ;(async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abortController.signal })) {
          try {
            if (event.type === 'session.deleted') {
              const sessionID = event.data?.sessionID
              if (sessionID) {
                // Ordered on the same per-session write chain as regular
                // persists -- a removal racing an in-flight write could
                // otherwise be overtaken and resurrect the entry
                // (design.md D11).
                if (storageAvailable) {
                  await enqueueWrite(sessionID, () => ctx.storage.remove(storageKeyFor(sessionID)))
                }
                forgetSession(sessionID)
              }
              continue
            }
            await handleNormalizedEvent(normalize(event))
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

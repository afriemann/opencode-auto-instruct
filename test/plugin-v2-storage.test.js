// spec: openspec/changes/persist-modifier-state-ctx-storage/specs/rule-based-instruction-injection/spec.md
//
// V2-only tests for the ctx.storage-backed modifier-state durability
// feature (design.md D19). This is deliberately a separate file from
// test/plugin-conformance.test.js, which exists to keep V1/V2 *parity* --
// this feature has no V1 counterpart, and the concurrency tests need a
// fake storage.get() whose resolution can be deferred and released by the
// test, which does not belong in the shared conformance fake.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function withConfigFile(rules) {
  const dir = await mkdtemp(join(tmpdir(), 'auto-instruct-storage-'))
  const path = join(dir, 'auto-instruct.json')
  await writeFile(path, JSON.stringify({ rules }))
  process.env.OPENCODE_AUTO_INSTRUCT_CONFIG = path
  return async () => {
    delete process.env.OPENCODE_AUTO_INSTRUCT_CONFIG
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * A fake ctx.storage backed by an in-memory Map, with the ability to defer
 * a specific pending `get()` resolution until the test releases it -- the
 * only way to assert single-flight hydration deterministically.
 */
function makeFakeStorage({ initial = {}, failGet = false, failSet = false } = {}) {
  const store = new Map(Object.entries(initial))
  const getCalls = []
  const setCalls = []
  const removeCalls = []
  /** array of { key, resolve } for gets that are being held open */
  const pendingGets = []
  let deferGets = false

  const storage = {
    async get(key) {
      getCalls.push(key)
      if (failGet) throw new Error('storage get failed')
      if (deferGets) {
        return new Promise((resolve) => {
          pendingGets.push({ key, resolve: () => resolve(store.get(key)) })
        })
      }
      return store.get(key)
    },
    async set(key, value) {
      setCalls.push({ key, value })
      if (failSet) throw new Error('storage set failed')
      store.set(key, value)
    },
    async remove(key) {
      removeCalls.push(key)
      store.delete(key)
    },
  }

  return {
    storage,
    store,
    getCalls,
    setCalls,
    removeCalls,
    startDeferringGets() { deferGets = true },
    releaseOnePendingGet() {
      const next = pendingGets.shift()
      next?.resolve()
    },
    pendingGetCount: () => pendingGets.length,
  }
}

function makeFakeV2Ctx({ sessionAgent = 'build', storage } = {}) {
  const syntheticCalls = []
  const switchAgentCalls = []
  const eventListeners = []
  const toolHooks = new Map()

  const ctx = {
    session: {
      get: async () => ({ agent: sessionAgent }),
      synthetic: async (input) => { syntheticCalls.push(input) },
      switchAgent: async (input) => { switchAgentCalls.push(input) },
    },
    event: {
      subscribe({ signal }) {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return new Promise((resolvePromise) => {
                  eventListeners.push(resolvePromise)
                  signal.addEventListener('abort', () => resolvePromise({ done: true, value: undefined }), { once: true })
                })
              },
            }
          },
        }
      },
    },
    tool: {
      hook(name, callback) {
        const callbacks = toolHooks.get(name) ?? []
        callbacks.push(callback)
        toolHooks.set(name, callbacks)
      },
    },
    ...(storage ? { storage } : {}),
  }

  return {
    ctx,
    syntheticCalls,
    switchAgentCalls,
    pendingListenerCount: () => eventListeners.length,
    emitEvent(event) {
      const listener = eventListeners.shift()
      listener?.({ done: false, value: event })
    },
    async emitToolEvent(event) {
      const callbacks = toolHooks.get('execute.after') ?? []
      for (const callback of callbacks) await callback(event)
    },
  }
}

async function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr)
  const lines = []
  process.stderr.write = (chunk) => {
    lines.push(String(chunk))
    return true
  }
  try {
    await fn()
  } finally {
    process.stderr.write = original
  }
  return lines
}

async function loadV2(rules, ctxOverrides = {}) {
  const cleanup = await withConfigFile(rules)
  try {
    const mod = await import('../src/plugin.v2.js?t=' + Date.now() + Math.random())
    const fake = makeFakeV2Ctx(ctxOverrides)
    const pluginCleanup = await mod.default.setup(fake.ctx)
    return { pluginCleanup, ...fake, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}

// A short async tick, enough for a chain of already-resolved promises to settle.
function tick(n = 3) {
  let p = Promise.resolve()
  for (let i = 0; i < n; i++) p = p.then(() => {})
  return p
}

// Polls until the event-subscribe loop has re-registered its `next()`
// listener, so a second `emitEvent()` for the same session is guaranteed to
// be delivered rather than silently dropped into an empty listener queue
// (a real risk with the pull-based fake event source when firing two
// sequential events for one session without synchronizing on readiness).
async function waitForListener(fake, { timeoutMs = 1000 } = {}) {
  const start = Date.now()
  while (fake.pendingListenerCount() === 0) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for the event-subscribe loop to re-register its listener')
    }
    await tick(1)
  }
}

async function emitEventAndWaitForNext(fake, event) {
  await waitForListener(fake)
  fake.emitEvent(event)
}

describe('V2 modifier state durability', () => {
  it('hydrates a once rule\'s fired state on restart and does not re-fire it', async () => {
    const fakeStorage = makeFakeStorage({
      initial: { 'modifierState:s1': { v: 1, rules: { r1: { lastMatch: true, fired: true } } } },
    })
    const { pluginCleanup, syntheticCalls, emitEvent, cleanup } = await loadV2(
      [{ id: 'r1', event: 'session.created', once: true, instruction: 'do X' }],
      { storage: fakeStorage.storage },
    )
    try {
      emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await tick()
      assert.equal(syntheticCalls.length, 0, 'a once rule already fired before restart must not re-fire after hydration')
      assert.deepEqual(fakeStorage.getCalls, ['modifierState:s1'])
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('hydrates an edge:rise rule\'s prior boolean on restart and honours the transition', async () => {
    const fakeStorage = makeFakeStorage({
      initial: { 'modifierState:s1': { v: 1, rules: { r1: { lastMatch: true, fired: false } } } },
    })
    const { pluginCleanup, syntheticCalls, emitToolEvent, cleanup } = await loadV2(
      [{ id: 'r1', event: 'tool.execute.after', edge: 'rise', condition: { type: 'toolName', tool: 'bash' }, instruction: 'do X' }],
      { storage: fakeStorage.storage },
    )
    try {
      await emitToolEvent({ sessionID: 's1', agent: 'build', tool: 'bash', status: 'completed' })
      assert.equal(syntheticCalls.length, 0, 'rise must not re-fire when the restored prior state was already matching')
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('hydrates exactly once for two events on the same never-before-seen session arriving concurrently (single-flight)', async () => {
    const fakeStorage = makeFakeStorage({})
    fakeStorage.startDeferringGets()
    const { pluginCleanup, syntheticCalls, emitToolEvent, cleanup } = await loadV2(
      [{ id: 'r1', event: 'tool.execute.after', once: true, condition: { type: 'toolName', tool: 'bash' }, instruction: 'do X' }],
      { storage: fakeStorage.storage },
    )
    try {
      const first = emitToolEvent({ sessionID: 's1', agent: 'build', tool: 'bash', status: 'completed' })
      const second = emitToolEvent({ sessionID: 's1', agent: 'build', tool: 'bash', status: 'completed' })
      await tick()
      assert.equal(fakeStorage.getCalls.length, 1, 'exactly one storage.get for the shared session, not two')
      fakeStorage.releaseOnePendingGet()
      await Promise.all([first, second])
      // once:true -> exactly one of the two concurrent events fires, never both.
      assert.equal(syntheticCalls.length, 1, 'no lost update: the once rule fires exactly one time, not zero and not twice')
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('malformed stored state (wrong shape) is treated as no prior state, without throwing', async () => {
    const fakeStorage = makeFakeStorage({
      initial: { 'modifierState:s1': { v: 1, rules: 'not-an-object' } },
    })
    const { pluginCleanup, syntheticCalls, emitEvent, cleanup } = await loadV2(
      [{ id: 'r1', event: 'session.created', once: true, instruction: 'do X' }],
      { storage: fakeStorage.storage },
    )
    try {
      emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await tick()
      assert.equal(syntheticCalls.length, 1, 'malformed stored state must not prevent the rule from firing as if fresh')
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('a storage.get rejection is treated as no prior state, without throwing, and processing continues', async () => {
    const fakeStorage = makeFakeStorage({ failGet: true })
    const { pluginCleanup, syntheticCalls, emitEvent, cleanup } = await loadV2(
      [{ id: 'r1', event: 'session.created', once: true, instruction: 'do X' }],
      { storage: fakeStorage.storage },
    )
    try {
      emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await tick()
      assert.equal(syntheticCalls.length, 1, 'a storage read failure must still allow the rule to fire as if no prior state existed')
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('a storage.set rejection is logged and does not throw or block subsequent events', async () => {
    const fakeStorage = makeFakeStorage({ failSet: true })
    const { pluginCleanup, syntheticCalls, emitEvent, cleanup } = await loadV2(
      [{ id: 'r1', event: 'session.created', once: true, instruction: 'do X' }],
      { storage: fakeStorage.storage },
    )
    const lines = await captureStderr(async () => {
      emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await tick(10)
    })
    try {
      assert.equal(syntheticCalls.length, 1)
      assert.ok(lines.some((l) => l.includes('[warn]') && l.includes('write failed')), 'expected a warning about the failed write')
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('a no-change re-evaluation issues zero additional writes (dirty-check)', async () => {
    const fakeStorage = makeFakeStorage({})
    const { pluginCleanup, emitToolEvent, cleanup } = await loadV2(
      [{ id: 'r1', event: 'tool.execute.after', edge: 'rise', condition: { type: 'toolName', tool: 'bash' }, instruction: 'do X' }],
      { storage: fakeStorage.storage },
    )
    try {
      await emitToolEvent({ sessionID: 's1', agent: 'build', tool: 'bash', status: 'completed' })
      await tick()
      const writesAfterFirst = fakeStorage.setCalls.length
      assert.equal(writesAfterFirst, 1, 'the transition itself must persist')

      await emitToolEvent({ sessionID: 's1', agent: 'build', tool: 'bash', status: 'completed' })
      await tick()
      assert.equal(fakeStorage.setCalls.length, writesAfterFirst, 'a repeat evaluation with no state change must not write again')
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('removes a session\'s persisted state on session.deleted, ordered after a pending write', async () => {
    const fakeStorage = makeFakeStorage({})
    const { pluginCleanup, emitEvent, emitToolEvent, cleanup } = await loadV2(
      [{ id: 'r1', event: 'tool.execute.after', edge: 'rise', condition: { type: 'toolName', tool: 'bash' }, instruction: 'do X' }],
      { storage: fakeStorage.storage },
    )
    try {
      await emitToolEvent({ sessionID: 's1', agent: 'build', tool: 'bash', status: 'completed' })
      emitEvent({ type: 'session.deleted', data: { sessionID: 's1' } })
      await tick()
      assert.deepEqual(fakeStorage.removeCalls, ['modifierState:s1'])
      assert.equal(fakeStorage.store.has('modifierState:s1'), false)
      // The write that preceded the removal must have actually landed
      // first -- not been dropped or overtaken by the remove.
      assert.equal(fakeStorage.setCalls.length, 1)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('makes zero storage calls when no loaded rule uses once/edge modifiers', async () => {
    const fakeStorage = makeFakeStorage({})
    const { pluginCleanup, syntheticCalls, emitEvent, cleanup } = await loadV2(
      [{ id: 'r1', event: 'session.created', instruction: 'do X' }],
      { storage: fakeStorage.storage },
    )
    try {
      emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await tick()
      assert.equal(syntheticCalls.length, 1)
      assert.equal(fakeStorage.getCalls.length, 0)
      assert.equal(fakeStorage.setCalls.length, 0)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('runs entirely in-memory-only, with no thrown error, when ctx.storage is absent', async () => {
    const { pluginCleanup, syntheticCalls, emitEvent, pendingListenerCount, cleanup } = await loadV2(
      [{ id: 'r1', event: 'session.created', once: true, instruction: 'do X' }],
      {},
    )
    const fake = { pendingListenerCount, emitEvent }
    try {
      await waitForListener(fake)
      fake.emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await tick()
      assert.equal(syntheticCalls.length, 1, 'first matching event fires the once rule')

      // Second event for the SAME session, in the SAME process: once:true
      // must not re-fire it -- this is in-memory state within one process,
      // independent of whether ctx.storage exists at all.
      await emitEventAndWaitForNext(fake, { type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await tick()
      assert.equal(syntheticCalls.length, 1, 'in-memory once semantics still hold within the same process when ctx.storage is absent')
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('does not redundantly re-switch a session whose persistent switchToAgent already fired, after a restart', async () => {
    const fakeStorage = makeFakeStorage({
      initial: { 'modifierState:s1': { v: 1, rules: { r1: { lastMatch: true, fired: true } } } },
    })
    const { pluginCleanup, syntheticCalls, switchAgentCalls, emitEvent, cleanup } = await loadV2(
      [{ id: 'r1', event: 'session.created', once: true, switchToAgent: 'review', instruction: 'do X' }],
      { storage: fakeStorage.storage, sessionAgent: 'build' },
    )
    try {
      emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await tick()
      assert.equal(syntheticCalls.length, 0, 'the once rule must not re-fire after hydrating an already-fired state')
      assert.equal(switchAgentCalls.length, 0, 'a rule that does not fire must not call switchAgent, persistent or not')
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('logs hydrated rule ids and their state when debug is enabled', async () => {
    const fakeStorage = makeFakeStorage({
      initial: { 'modifierState:s1': { v: 1, rules: { r1: { lastMatch: true, fired: true } } } },
    })
    const cleanupConfig = await (async () => {
      const dir = await mkdtemp(join(tmpdir(), 'auto-instruct-storage-debug-'))
      const path = join(dir, 'auto-instruct.json')
      await writeFile(path, JSON.stringify({ debug: true, rules: [{ id: 'r1', event: 'session.created', once: true, instruction: 'do X' }] }))
      process.env.OPENCODE_AUTO_INSTRUCT_CONFIG = path
      return async () => {
        delete process.env.OPENCODE_AUTO_INSTRUCT_CONFIG
        await rm(dir, { recursive: true, force: true })
      }
    })()
    try {
      const mod = await import('../src/plugin.v2.js?t=' + Date.now() + Math.random())
      const fake = makeFakeV2Ctx({ storage: fakeStorage.storage })
      const lines = await captureStderr(async () => {
        const pluginCleanup = await mod.default.setup(fake.ctx)
        fake.emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
        await tick()
        await pluginCleanup()
      })
      assert.ok(lines.some((l) => l.includes('[debug]') && l.includes('hydrated session=s1') && l.includes('r1')))
    } finally {
      await cleanupConfig()
    }
  })
})

// spec: openspec/changes/v2-plugin-migration/design.md section 6, Layer 2
//
// One shared conformance suite executed against a fake V1 host and a fake
// V2 ctx -- this is what stops the two adapters drifting. Runtime-neutral
// assertions are identical on both sides; runtime-specific assertions
// (delivery shape, agent resolution field, cleanup) are separate per side.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function withConfigFile(rules) {
  const dir = await mkdtemp(join(tmpdir(), 'auto-instruct-conformance-'))
  const path = join(dir, 'auto-instruct.json')
  await writeFile(path, JSON.stringify({ rules }))
  process.env.OPENCODE_AUTO_INSTRUCT_CONFIG = path
  return async () => {
    delete process.env.OPENCODE_AUTO_INSTRUCT_CONFIG
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// V1 fake host
// ---------------------------------------------------------------------------

function makeFakeV1Client({ sessionAgent = 'build' } = {}) {
  const promptCalls = []
  const client = {
    app: { log: () => Promise.resolve() },
    session: {
      get: async () => ({ data: { agent: sessionAgent } }),
      promptAsync: async (input) => {
        promptCalls.push(input)
      },
    },
  }
  return { client, promptCalls }
}

async function loadV1(rules, clientOverrides = {}) {
  const cleanup = await withConfigFile(rules)
  try {
    const mod = await import('../src/plugin.v1.js?t=' + Date.now())
    const { client, promptCalls } = makeFakeV1Client(clientOverrides)
    const hooks = await mod.default({ client })
    return { hooks, promptCalls, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}

// ---------------------------------------------------------------------------
// V2 fake ctx
// ---------------------------------------------------------------------------

function makeFakeV2Ctx({ sessionAgent = 'build' } = {}) {
  const syntheticCalls = []
  const switchAgentCalls = []
  const eventListeners = []
  /** name ("execute.after") -> array of registered callbacks */
  const toolHooks = new Map()

  const ctx = {
    session: {
      get: async () => ({ agent: sessionAgent }),
      synthetic: async (input) => {
        syntheticCalls.push(input)
      },
      switchAgent: async (input) => {
        switchAgentCalls.push(input)
      },
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
  }

  return {
    ctx,
    syntheticCalls,
    switchAgentCalls,
    emitEvent(event) {
      const listener = eventListeners.shift()
      listener?.({ done: false, value: event })
    },
    /** Invokes every callback registered for ctx.tool.hook('execute.after', ...). */
    async emitToolEvent(event) {
      const callbacks = toolHooks.get('execute.after') ?? []
      for (const callback of callbacks) await callback(event)
    },
  }
}

// Captures every process.stderr.write call for the duration of a callback
// (V2's makeLogger() is stderr-only -- there's no injected logger to spy on
// directly), then restores the original write. Returns the captured lines.
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
    const mod = await import('../src/plugin.v2.js?t=' + Date.now())
    const { ctx, syntheticCalls, switchAgentCalls, emitEvent, emitToolEvent } = makeFakeV2Ctx(ctxOverrides)
    const pluginCleanup = await mod.default.setup(ctx)
    return { pluginCleanup, syntheticCalls, switchAgentCalls, emitEvent, emitToolEvent, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}

// ---------------------------------------------------------------------------
// Runtime-neutral assertions
// ---------------------------------------------------------------------------

describe('V1 adapter conformance', () => {
  it('a matching rule delivers exactly one instruction', async () => {
    const { hooks, promptCalls, cleanup } = await loadV1([
      { id: 'r1', event: 'session.created', instruction: 'do X' },
    ])
    try {
      await hooks.event({ event: { type: 'session.created', properties: { info: { id: 's1', agent: 'build' } } } })
      assert.equal(promptCalls.length, 1)
      assert.match(promptCalls[0].body.parts[0].text, /do X/)
    } finally {
      await cleanup()
    }
  })

  it('promptAsync receives {system, noReply, agent, parts[0].synthetic}', async () => {
    const { hooks, promptCalls, cleanup } = await loadV1([
      { id: 'r1', event: 'session.created', instruction: 'do X', hidden: true, noReply: true, switchToAgent: 'review' },
    ])
    try {
      await hooks.event({ event: { type: 'session.created', properties: { info: { id: 's1', agent: 'build' } } } })
      const call = promptCalls[0]
      assert.equal(call.body.noReply, true)
      assert.equal(call.body.agent, 'review')
      assert.equal(call.body.parts[0].synthetic, true)
      assert.match(call.body.system, /do not mention/i)
    } finally {
      await cleanup()
    }
  })

  it('agent is read from res.data.agent', async () => {
    const { hooks, promptCalls, cleanup } = await loadV1([
      { id: 'r1', event: 'session.created', instruction: 'do X', agents: 'build' },
    ])
    try {
      await hooks.event({ event: { type: 'session.created', properties: { info: { id: 's1' } } } })
      assert.equal(promptCalls.length, 1)
    } finally {
      await cleanup()
    }
  })

  it('events with no resolvable session ID evaluate no rules', async () => {
    const { hooks, promptCalls, cleanup } = await loadV1([
      { id: 'r1', event: 'session.created', instruction: 'do X' },
    ])
    try {
      await hooks.event({ event: { type: 'session.created', properties: {} } })
      assert.equal(promptCalls.length, 0)
    } finally {
      await cleanup()
    }
  })

  it('a delivery failure on rule 1 does not prevent rule 2', async () => {
    const cleanup = await withConfigFile([
      { id: 'r1', event: 'session.created', instruction: 'fails' },
      { id: 'r2', event: 'session.created', instruction: 'succeeds' },
    ])
    try {
      const mod = await import('../src/plugin.v1.js?t=' + Date.now())
      let call = 0
      const client = {
        app: { log: () => Promise.resolve() },
        session: {
          get: async () => ({ data: { agent: 'build' } }),
          promptAsync: async () => {
            call += 1
            if (call === 1) throw new Error('boom')
          },
        },
      }
      const hooks = await mod.default({ client })
      await hooks.event({ event: { type: 'session.created', properties: { info: { id: 's1', agent: 'build' } } } })
      assert.equal(call, 2, 'both rules were attempted')
    } finally {
      await cleanup()
    }
  })

  it('once state does not survive a restart on V1 (in-memory-only, unlike V2)', async () => {
    const cleanup = await withConfigFile([
      { id: 'r1', event: 'session.created', once: true, instruction: 'do X' },
    ])
    try {
      // Two independent module loads simulate two separate process
      // lifetimes against the same conversation session -- V1 has no
      // storage surface, so each fresh load starts with an empty
      // in-memory sessionStates map (spec: "V1 modifier state does not
      // survive a restart").
      const firstProcess = await import('../src/plugin.v1.js?t=' + Date.now() + '-a')
      const firstHooks = await firstProcess.default({ client: makeFakeV1Client().client })
      await firstHooks.event({ event: { type: 'session.created', properties: { info: { id: 's1', agent: 'build' } } } })

      const secondProcess = await import('../src/plugin.v1.js?t=' + Date.now() + '-b')
      const { client: secondClient, promptCalls: secondCalls } = makeFakeV1Client()
      const secondHooks = await secondProcess.default({ client: secondClient })
      await secondHooks.event({ event: { type: 'session.created', properties: { info: { id: 's1', agent: 'build' } } } })

      assert.equal(secondCalls.length, 1, 'the once rule fires again after a simulated restart on V1')
    } finally {
      await cleanup()
    }
  })

  it('toolName fires on V1 via the real message.part.updated path', async () => {
    const { hooks, promptCalls, cleanup } = await loadV1([
      { id: 'r1', event: 'tool.execute.after', condition: { type: 'toolName', tool: 'bash' }, instruction: 'do X' },
    ])
    try {
      await hooks.event({
        event: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part1', sessionID: 's1', messageID: 'm1', type: 'tool', callID: 'call1', tool: 'bash',
              state: { status: 'completed', input: {}, output: '', title: '', metadata: {}, time: { start: 0, end: 1 } },
            },
          },
        },
      })
      assert.equal(promptCalls.length, 1)
    } finally {
      await cleanup()
    }
  })

  it('toolNameIn fires on V1 via the real message.part.updated path', async () => {
    const { hooks, promptCalls, cleanup } = await loadV1([
      { id: 'r1', event: 'tool.execute.after', condition: { type: 'toolNameIn', tools: ['read', 'edit'] }, instruction: 'do X' },
    ])
    try {
      await hooks.event({
        event: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part1', sessionID: 's1', messageID: 'm1', type: 'tool', callID: 'call1', tool: 'read',
              state: { status: 'completed', input: {}, output: '', title: '', metadata: {}, time: { start: 0, end: 1 } },
            },
          },
        },
      })
      assert.equal(promptCalls.length, 1)
    } finally {
      await cleanup()
    }
  })

  it('a data condition fires on V1 using part.state.metadata', async () => {
    const { hooks, promptCalls, cleanup } = await loadV1([
      { id: 'r1', event: 'tool.execute.after', condition: { type: 'dataArrayNonEmpty', path: 'todos', tool: 'todowrite' }, instruction: 'do X' },
    ])
    try {
      await hooks.event({
        event: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part1', sessionID: 's1', messageID: 'm1', type: 'tool', callID: 'call1', tool: 'todowrite',
              state: { status: 'completed', input: {}, output: '', title: '', metadata: { todos: [{ status: 'pending' }] }, time: { start: 0, end: 1 } },
            },
          },
        },
      })
      assert.equal(promptCalls.length, 1)
    } finally {
      await cleanup()
    }
  })

  it('an in-progress (non-completed) tool part does not fire any rule (early bail)', async () => {
    const { hooks, promptCalls, cleanup } = await loadV1([
      { id: 'r1', event: 'tool.execute.after', condition: { type: 'toolName', tool: 'bash' }, instruction: 'do X' },
    ])
    try {
      await hooks.event({
        event: {
          type: 'message.part.updated',
          properties: {
            part: { id: 'part1', sessionID: 's1', messageID: 'm1', type: 'tool', callID: 'call1', tool: 'bash', state: { status: 'running' } },
          },
        },
      })
      assert.equal(promptCalls.length, 0)
    } finally {
      await cleanup()
    }
  })

  it('a repeated message.part.updated delivery for the same callID is deduplicated', async () => {
    const { hooks, promptCalls, cleanup } = await loadV1([
      { id: 'r1', event: 'tool.execute.after', condition: { type: 'toolName', tool: 'bash' }, instruction: 'do X' },
    ])
    try {
      const part = {
        id: 'part1', sessionID: 's1', messageID: 'm1', type: 'tool', callID: 'call1', tool: 'bash',
        state: { status: 'completed', input: {}, output: '', title: '', metadata: {}, time: { start: 0, end: 1 } },
      }
      await hooks.event({ event: { type: 'message.part.updated', properties: { part } } })
      await hooks.event({ event: { type: 'message.part.updated', properties: { part } } })
      assert.equal(promptCalls.length, 1, 'the second delivery for the same callID must be deduplicated')
    } finally {
      await cleanup()
    }
  })

  it('Session ID for a completed V1 tool part is read from the part itself', async () => {
    const { hooks, promptCalls, cleanup } = await loadV1([
      { id: 'r1', event: 'tool.execute.after', instruction: 'do X' },
    ])
    try {
      await hooks.event({
        event: {
          type: 'message.part.updated',
          // No properties.sessionID or properties.info.id anywhere on the
          // envelope -- only part.sessionID carries it for this event kind.
          properties: {
            part: {
              id: 'part1', sessionID: 's1', messageID: 'm1', type: 'tool', callID: 'call1', tool: 'bash',
              state: { status: 'completed', input: {}, output: '', title: '', metadata: {}, time: { start: 0, end: 1 } },
            },
          },
        },
      })
      assert.equal(promptCalls.length, 1, 'rule evaluation must proceed using part.sessionID')
    } finally {
      await cleanup()
    }
  })
})

describe('V2 adapter conformance', () => {
  it('a matching rule delivers exactly one instruction via ctx.session.synthetic', async () => {
    const { pluginCleanup, syntheticCalls, emitEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'session.created', instruction: 'do X' },
    ])
    try {
      emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await new Promise((r) => setImmediate(r))
      assert.equal(syntheticCalls.length, 1)
      assert.match(syntheticCalls[0].text, /do X/)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('synthetic receives resume:false when noReply, and omits description when hidden', async () => {
    const { pluginCleanup, syntheticCalls, emitEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'session.created', instruction: 'do X', hidden: true, noReply: true },
    ])
    try {
      emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await new Promise((r) => setImmediate(r))
      const call = syntheticCalls[0]
      assert.equal(call.resume, false)
      assert.equal(call.description, undefined)
      assert.match(call.text, /do not mention/i)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('non-hidden delivery sets a description', async () => {
    const { pluginCleanup, syntheticCalls, emitEvent, cleanup } = await loadV2([
      { id: 'my-rule', event: 'session.created', instruction: 'do X' },
    ])
    try {
      emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await new Promise((r) => setImmediate(r))
      assert.equal(syntheticCalls[0].description, 'my-rule')
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('agent is read from the unwrapped res.agent (not res.data.agent)', async () => {
    const { pluginCleanup, syntheticCalls, emitEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'session.created', instruction: 'do X', agents: 'build' },
    ], { sessionAgent: 'build' })
    try {
      emitEvent({ type: 'session.created', data: { sessionID: 's1' } }) // no agentHint -- forces ctx.session.get()
      await new Promise((r) => setImmediate(r))
      assert.equal(syntheticCalls.length, 1)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('switchAgent is called before delivery when switchToAgent differs from the resolved agent', async () => {
    const { pluginCleanup, switchAgentCalls, syntheticCalls, emitEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'session.created', instruction: 'do X', switchToAgent: 'review' },
    ], { sessionAgent: 'build' })
    try {
      emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await new Promise((r) => setImmediate(r))
      assert.equal(switchAgentCalls.length, 1)
      assert.equal(switchAgentCalls[0].agent, 'review')
      assert.equal(syntheticCalls.length, 1)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('switchAgent is NOT called when the target already equals the resolved agent', async () => {
    const { pluginCleanup, switchAgentCalls, emitEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'session.created', instruction: 'do X', switchToAgent: 'build' },
    ], { sessionAgent: 'build' })
    try {
      emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await new Promise((r) => setImmediate(r))
      assert.equal(switchAgentCalls.length, 0)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('a second rule targeting the same agent an earlier rule already switched to does not re-switch', async () => {
    // Regression test: the decisions loop must re-read the live per-session
    // agent (sessionAgents cache), not the stale per-event resolvedAgentName,
    // so that rule 2 (also targeting "review") sees rule 1's switch and skips.
    const { pluginCleanup, switchAgentCalls, syntheticCalls, emitEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'session.created', instruction: 'do X', switchToAgent: 'review' },
      { id: 'r2', event: 'session.created', instruction: 'do Y', switchToAgent: 'review' },
    ], { sessionAgent: 'build' })
    try {
      emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await new Promise((r) => setImmediate(r))
      assert.equal(switchAgentCalls.length, 1, 'only rule 1 should trigger a real switchAgent call')
      assert.equal(switchAgentCalls[0].agent, 'review')
      assert.equal(syntheticCalls.length, 2, 'both rules must still deliver their instruction')
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('a legacy removed condition type never matches on V2 (removed on all runtimes)', async () => {
    const { pluginCleanup, syntheticCalls, emitEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'tool.execute.after', condition: { type: 'allTodosComplete' }, instruction: 'do X' },
    ])
    try {
      emitEvent({ type: 'session.created', data: { sessionID: 's1', agent: 'build' } })
      await new Promise((r) => setImmediate(r))
      assert.equal(syntheticCalls.length, 0)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('a data condition matches a tool-hook event on V2 using result.metadata', async () => {
    const { pluginCleanup, syntheticCalls, emitToolEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'tool.execute.after', condition: { type: 'dataArrayNonEmpty', path: 'todos', tool: 'todowrite' }, instruction: 'do X' },
    ])
    try {
      await emitToolEvent({
        tool: 'todowrite', sessionID: 's1', agent: 'build', messageID: 'm1', id: 'call1',
        input: {}, status: 'completed', result: { content: [], metadata: { todos: [{ status: 'pending' }] } },
      })
      assert.equal(syntheticCalls.length, 1)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('a data condition is not applicable for a failed/errored tool call (no metadata read)', async () => {
    const { pluginCleanup, syntheticCalls, emitToolEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'tool.execute.after', condition: { type: 'dataArrayNonEmpty', path: 'todos', tool: 'todowrite' }, instruction: 'do X' },
    ])
    try {
      await emitToolEvent({
        tool: 'todowrite', sessionID: 's1', agent: 'build', messageID: 'm1', id: 'call1',
        input: {}, status: 'error', error: { message: 'boom' },
      })
      assert.equal(syntheticCalls.length, 0)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('toolName matches a tool-hook event on V2', async () => {
    const { pluginCleanup, syntheticCalls, emitToolEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'tool.execute.after', condition: { type: 'toolName', tool: 'bash' }, instruction: 'do X' },
    ])
    try {
      await emitToolEvent({
        tool: 'bash', sessionID: 's1', agent: 'build', messageID: 'm1', id: 'call1',
        input: {}, status: 'completed', result: { content: [] },
      })
      assert.equal(syntheticCalls.length, 1)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('toolNameIn matches a tool-hook event on V2', async () => {
    const { pluginCleanup, syntheticCalls, emitToolEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'tool.execute.after', condition: { type: 'toolNameIn', tools: ['read', 'edit'] }, instruction: 'do X' },
    ])
    try {
      await emitToolEvent({
        tool: 'read', sessionID: 's1', agent: 'build', messageID: 'm1', id: 'call1',
        input: {}, status: 'completed', result: { content: [] },
      })
      assert.equal(syntheticCalls.length, 1)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('toolName does not match a non-matching tool-hook event on V2', async () => {
    const { pluginCleanup, syntheticCalls, emitToolEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'tool.execute.after', condition: { type: 'toolName', tool: 'bash' }, instruction: 'do X' },
    ])
    try {
      await emitToolEvent({
        tool: 'read', sessionID: 's1', agent: 'build', messageID: 'm1', id: 'call1',
        input: {}, status: 'completed', result: { content: [] },
      })
      assert.equal(syntheticCalls.length, 0)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('warns once at load time for a rule with an unsupported condition type', async () => {
    let result
    const lines = await captureStderr(async () => {
      result = await loadV2([
        { id: 'r1', event: 'session.created', condition: { type: 'allTodosComplete' }, instruction: 'do X' },
      ])
    })
    try {
      const warnLines = lines.filter((l) => l.includes('[warn]'))
      assert.equal(warnLines.length, 1, `expected exactly one warn line, got: ${JSON.stringify(lines)}`)
      assert.match(warnLines[0], /condition type "allTodosComplete"/)
    } finally {
      await result.pluginCleanup()
      await result.cleanup()
    }
  })

  it('warns once at load time for a rule bound to an unsupported trigger event', async () => {
    let result
    const lines = await captureStderr(async () => {
      result = await loadV2([
        { id: 'r1', event: 'todo.updated', instruction: 'do X' },
      ])
    })
    try {
      const warnLines = lines.filter((l) => l.includes('[warn]'))
      assert.equal(warnLines.length, 1, `expected exactly one warn line, got: ${JSON.stringify(lines)}`)
      assert.match(warnLines[0], /event "todo\.updated"/)
    } finally {
      await result.pluginCleanup()
      await result.cleanup()
    }
  })

  it('warns exactly once (not twice) when both an unsupported condition type and an unsupported event apply', async () => {
    let result
    const lines = await captureStderr(async () => {
      result = await loadV2([
        { id: 'r1', event: 'todo.updated', condition: { type: 'allTodosComplete' }, instruction: 'do X' },
      ])
    })
    try {
      const warnLines = lines.filter((l) => l.includes('[warn]'))
      assert.equal(warnLines.length, 1, `expected exactly one warn line (branches must be mutually exclusive), got: ${JSON.stringify(lines)}`)
    } finally {
      await result.pluginCleanup()
      await result.cleanup()
    }
  })

  it('does not warn for a fully-supported rule', async () => {
    let result
    const lines = await captureStderr(async () => {
      result = await loadV2([
        { id: 'r1', event: 'message.updated', condition: { type: 'messageFinished' }, instruction: 'do X' },
      ])
    })
    try {
      const warnLines = lines.filter((l) => l.includes('[warn]'))
      assert.equal(warnLines.length, 0, `expected no warn lines, got: ${JSON.stringify(lines)}`)
    } finally {
      await result.pluginCleanup()
      await result.cleanup()
    }
  })

  it('does not warn for a rule using toolName/toolNameIn (now supported via ctx.tool.hook)', async () => {
    let result
    const lines = await captureStderr(async () => {
      result = await loadV2([
        { id: 'r1', event: 'tool.execute.after', condition: { type: 'toolName', tool: 'bash' }, instruction: 'do X' },
      ])
    })
    try {
      const warnLines = lines.filter((l) => l.includes('[warn]'))
      assert.equal(warnLines.length, 0, `expected no warn lines, got: ${JSON.stringify(lines)}`)
    } finally {
      await result.pluginCleanup()
      await result.cleanup()
    }
  })

  it('messageFinished does not match an errored session.step.ended (D3)', async () => {
    const { pluginCleanup, syntheticCalls, emitEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'message.updated', condition: { type: 'messageFinished' }, instruction: 'do X' },
    ])
    try {
      emitEvent({ type: 'session.step.ended', data: { sessionID: 's1', finish: 'error' } })
      await new Promise((r) => setImmediate(r))
      assert.equal(syntheticCalls.length, 0, 'an error finish must not match messageFinished')

      emitEvent({ type: 'session.step.ended', data: { sessionID: 's1', finish: 'failure' } })
      await new Promise((r) => setImmediate(r))
      assert.equal(syntheticCalls.length, 0, 'a failure finish must not match messageFinished')

      emitEvent({ type: 'session.step.ended', data: { sessionID: 's1', finish: 'stop' } })
      await new Promise((r) => setImmediate(r))
      assert.equal(syntheticCalls.length, 1, 'a successful finish must match')
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('events with no resolvable session ID evaluate no rules', async () => {
    const { pluginCleanup, syntheticCalls, emitEvent, cleanup } = await loadV2([
      { id: 'r1', event: 'session.created', instruction: 'do X' },
    ])
    try {
      emitEvent({ type: 'session.created', data: {} })
      await new Promise((r) => setImmediate(r))
      assert.equal(syntheticCalls.length, 0)
    } finally {
      await pluginCleanup()
      await cleanup()
    }
  })

  it('cleanup aborts the event subscription without throwing', async () => {
    const { pluginCleanup, cleanup } = await loadV2([])
    try {
      await pluginCleanup()
    } finally {
      await cleanup()
    }
  })

  it('a delivery failure on rule 1 does not prevent rule 2', async () => {
    const cleanup = await withConfigFile([
      { id: 'r1', event: 'session.created', instruction: 'fails' },
      { id: 'r2', event: 'session.created', instruction: 'succeeds' },
    ])
    try {
      const mod = await import('../src/plugin.v2.js?t=' + Date.now())
      let call = 0
      const eventListeners = []
      const ctx = {
        session: {
          get: async () => ({ agent: 'build' }),
          synthetic: async () => {
            call += 1
            if (call === 1) throw new Error('boom')
          },
          switchAgent: async () => {},
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
      }
      const pluginCleanup = await mod.default.setup(ctx)
      try {
        const listener = eventListeners.shift()
        listener?.({ done: false, value: { type: 'session.created', data: { sessionID: 's1', agent: 'build' } } })
        await new Promise((r) => setImmediate(r))
        assert.equal(call, 2, 'both rules were attempted')
      } finally {
        await pluginCleanup()
      }
    } finally {
      await cleanup()
    }
  })
})

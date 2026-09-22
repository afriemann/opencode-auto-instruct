// spec: openspec/specs/rule-based-instruction-injection/spec.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadRules,
  matchesAgents,
  checkCondition,
  validateRules,
  resolvePath,
  deepEqual,
  summarizeKeyPaths,
  buildFraming,
  evaluate,
  createSessionState,
  resolveConfigPath,
  REMOVED_LEGACY_CONDITION_TYPES,
  REMOVED_LEGACY_EVENT_TYPES,
} from '../src/core.js'

function makeLog() {
  const calls = []
  const log = (msg, err, level) => calls.push({ msg, err, level })
  log.calls = calls
  return log
}

async function withConfigFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'auto-instruct-core-test-'))
  const path = join(dir, 'auto-instruct.json')
  const previous = process.env.OPENCODE_AUTO_INSTRUCT_CONFIG
  process.env.OPENCODE_AUTO_INSTRUCT_CONFIG = path
  try {
    if (content !== null) await writeFile(path, content)
    await fn(path)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_AUTO_INSTRUCT_CONFIG
    else process.env.OPENCODE_AUTO_INSTRUCT_CONFIG = previous
    await rm(dir, { recursive: true, force: true })
  }
}

describe('resolveConfigPath', () => {
  it('honors OPENCODE_AUTO_INSTRUCT_CONFIG override', async () => {
    await withConfigFile('{}', async (path) => {
      assert.equal(resolveConfigPath(), path)
    })
  })

  it('defaults to ~/.config/opencode/auto-instruct.json when unset', () => {
    const previous = process.env.OPENCODE_AUTO_INSTRUCT_CONFIG
    delete process.env.OPENCODE_AUTO_INSTRUCT_CONFIG
    try {
      assert.match(resolveConfigPath(), /\.config\/opencode\/auto-instruct\.json$/)
    } finally {
      if (previous !== undefined) process.env.OPENCODE_AUTO_INSTRUCT_CONFIG = previous
    }
  })
})

describe('loadRules', () => {
  it('loads rules from a valid config file', async () => {
    await withConfigFile(JSON.stringify({ rules: [{ id: 'a', event: 'session.created' }] }), async () => {
      const log = makeLog()
      const { rules } = await loadRules(log)
      assert.equal(rules.length, 1)
      assert.equal(rules[0].id, 'a')
    })
  })

  it('missing config file is not an error and contributes zero rules', async () => {
    await withConfigFile(null, async () => {
      const log = makeLog()
      const { rules } = await loadRules(log)
      assert.deepEqual(rules, [])
      assert.equal(log.calls.length, 0)
    })
  })

  it('malformed JSON logs a warning and contributes zero rules', async () => {
    await withConfigFile('{not valid json', async () => {
      const log = makeLog()
      const { rules } = await loadRules(log)
      assert.deepEqual(rules, [])
      assert.equal(log.calls.length, 1)
      assert.equal(log.calls[0].level, 'warn')
    })
  })

  it('merges file rules before option rules', async () => {
    await withConfigFile(JSON.stringify({ rules: [{ id: 'file-rule' }] }), async () => {
      const log = makeLog()
      const { rules } = await loadRules(log, { rules: [{ id: 'option-rule' }] })
      assert.deepEqual(rules.map(r => r.id), ['file-rule', 'option-rule'])
    })
  })

  it('debug flag can come from file or options', async () => {
    await withConfigFile(JSON.stringify({ debug: true }), async () => {
      const log = makeLog()
      const { debug } = await loadRules(log)
      assert.equal(debug, true)
    })
    await withConfigFile(null, async () => {
      const log = makeLog()
      const { debug } = await loadRules(log, { debug: true })
      assert.equal(debug, true)
    })
  })
})

describe('matchesAgents', () => {
  it('no agents field matches any agent', () => {
    assert.equal(matchesAgents({}, 'build'), true)
    assert.equal(matchesAgents({}, null), true)
  })

  it('"*" matches any agent', () => {
    assert.equal(matchesAgents({ agents: '*' }, 'build'), true)
  })

  it('specific string matches only that agent', () => {
    assert.equal(matchesAgents({ agents: 'build' }, 'build'), true)
    assert.equal(matchesAgents({ agents: 'build' }, 'plan'), false)
  })

  it('array matches any in the list', () => {
    assert.equal(matchesAgents({ agents: ['build', 'plan'] }, 'plan'), true)
    assert.equal(matchesAgents({ agents: ['build', 'plan'] }, 'review'), false)
  })

  it('specific filter fails when agent is unresolved', () => {
    assert.equal(matchesAgents({ agents: 'build' }, null), false)
  })
})

describe('resolvePath', () => {
  it('resolves nested object keys', () => {
    const { ok, value } = resolvePath({ counts: { completed: 2 } }, 'counts.completed')
    assert.equal(ok, true)
    assert.equal(value, 2)
  })

  it('resolves numeric array indices', () => {
    const { ok, value } = resolvePath({ todos: [{ status: 'pending' }, { status: 'completed' }] }, 'todos.1.status')
    assert.equal(ok, true)
    assert.equal(value, 'completed')
  })

  it('empty path resolves to the root value', () => {
    const { ok, value } = resolvePath({ a: 1 }, '')
    assert.equal(ok, true)
    assert.deepEqual(value, { a: 1 })
  })

  it('an absent segment is not applicable', () => {
    assert.equal(resolvePath({ a: 1 }, 'b').ok, false)
    assert.equal(resolvePath(null, 'a').ok, false)
  })

  it('rejects __proto__, constructor, and prototype segments', () => {
    assert.equal(resolvePath({}, '__proto__').ok, false)
    assert.equal(resolvePath({}, 'constructor').ok, false)
    assert.equal(resolvePath({}, 'prototype').ok, false)
    assert.equal(resolvePath({}, 'a.__proto__.polluted').ok, false)
  })
})

describe('deepEqual', () => {
  it('compares primitives by strict equality', () => {
    assert.equal(deepEqual(1, 1), true)
    assert.equal(deepEqual(1, '1'), false)
    assert.equal(deepEqual(null, null), true)
    assert.equal(deepEqual(null, undefined), false)
  })

  it('compares objects by value, independent of key order', () => {
    assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true)
    assert.equal(deepEqual({ a: 1 }, { a: 2 }), false)
  })

  it('compares arrays recursively', () => {
    assert.equal(deepEqual([1, { a: 2 }], [1, { a: 2 }]), true)
    assert.equal(deepEqual([1, 2], [1, 2, 3]), false)
  })
})

describe('summarizeKeyPaths', () => {
  it('summarizes key paths with types, one level of nesting, and array lengths', () => {
    const summary = summarizeKeyPaths({ todos: [1, 2, 3], counts: { completed: 2 }, note: 'secret file contents' })
    assert.ok(summary.includes('todos:array(3)'))
    assert.ok(summary.includes('counts:object'))
    assert.ok(summary.includes('counts.completed:number'))
    assert.ok(summary.includes('note:string'))
  })

  it('never includes a resolved value in the summary', () => {
    const summary = summarizeKeyPaths({ secret: 'super-secret-token-value' })
    assert.ok(!summary.some((s) => s.includes('super-secret-token-value')))
  })

  it('returns an empty array for null or non-object input', () => {
    assert.deepEqual(summarizeKeyPaths(null), [])
    assert.deepEqual(summarizeKeyPaths('x'), [])
  })
})

describe('checkCondition', () => {
  const log = makeLog()

  it('no condition always matches', () => {
    const { result, applicable } = checkCondition({}, {}, createSessionState(), log)
    assert.equal(result, true)
    assert.equal(applicable, true)
  })

  it('messageFinished matches when finish is truthy', () => {
    const { result } = checkCondition({ condition: { type: 'messageFinished' } }, { finish: 'stop' }, createSessionState(), log)
    assert.equal(result, true)
  })

  it('toolName matches the exact configured tool', () => {
    const { result } = checkCondition({ condition: { type: 'toolName', tool: 'bash' } }, { toolName: 'bash' }, createSessionState(), log)
    assert.equal(result, true)
  })

  it('toolNameIn matches any tool in the list', () => {
    const { result } = checkCondition({ condition: { type: 'toolNameIn', tools: ['bash', 'edit'] } }, { toolName: 'edit' }, createSessionState(), log)
    assert.equal(result, true)
  })

  it('toolNameIn with a missing tools array warns and does not match', () => {
    const localLog = makeLog()
    const { result } = checkCondition({ id: 'r1', condition: { type: 'toolNameIn' } }, { toolName: 'bash' }, createSessionState(), localLog)
    assert.equal(result, false)
    assert.equal(localLog.calls.length, 1)
    assert.equal(localLog.calls[0].level, 'warn')
  })

  it('unknown condition type warns and does not match', () => {
    const localLog = makeLog()
    const { result, applicable } = checkCondition({ condition: { type: 'notReal' } }, {}, createSessionState(), localLog)
    assert.equal(result, false)
    assert.equal(applicable, true)
    assert.equal(localLog.calls[0].level, 'warn')
  })

  describe('data-predicate conditions', () => {
    const metaEvent = (toolMetadata, toolName = 'todowrite') => ({ toolMetadata, toolName })

    it('dataArrayNonEmpty matches a non-empty resolved array', () => {
      const nonEmpty = checkCondition({ condition: { type: 'dataArrayNonEmpty', path: 'todos' } }, metaEvent({ todos: [{ status: 'pending' }] }), createSessionState(), log)
      assert.equal(nonEmpty.result, true)
      const empty = checkCondition({ condition: { type: 'dataArrayEmpty', path: 'todos' } }, metaEvent({ todos: [] }), createSessionState(), log)
      assert.equal(empty.result, true)
    })

    it('dataArrayLengthAtLeast matches a length threshold', () => {
      const { result } = checkCondition(
        { condition: { type: 'dataArrayLengthAtLeast', path: 'todos', count: 2 } },
        metaEvent({ todos: [{ status: 'pending' }, { status: 'completed' }] }),
        createSessionState(), log,
      )
      assert.equal(result, true)
    })

    it('dataArrayAllMatch matches when every element satisfies the field comparison', () => {
      const { result } = checkCondition(
        { condition: { type: 'dataArrayAllMatch', path: 'todos', field: 'status', value: 'completed' } },
        metaEvent({ todos: [{ status: 'completed' }, { status: 'completed' }] }),
        createSessionState(), log,
      )
      assert.equal(result, true)
    })

    it('dataArrayAnyMatch matches when at least one element satisfies the field comparison', () => {
      const { result } = checkCondition(
        { condition: { type: 'dataArrayAnyMatch', path: 'todos', field: 'status', value: 'in_progress' } },
        metaEvent({ todos: [{ status: 'pending' }, { status: 'in_progress' }] }),
        createSessionState(), log,
      )
      assert.equal(result, true)
    })

    it('dataArrayNoneMatch matches when no element satisfies the field comparison', () => {
      const { result } = checkCondition(
        { condition: { type: 'dataArrayNoneMatch', path: 'todos', field: 'status', value: 'pending' } },
        metaEvent({ todos: [{ status: 'completed' }, { status: 'completed' }] }),
        createSessionState(), log,
      )
      assert.equal(result, true)
    })

    it('dataArrayAllMatch field:"" compares array elements directly', () => {
      const { result } = checkCondition(
        { condition: { type: 'dataArrayAllMatch', path: 'tags', field: '', value: 'x' } },
        metaEvent({ tags: ['x', 'x'] }),
        createSessionState(), log,
      )
      assert.equal(result, true)
    })

    it('dataEquals uses deep equality independent of key order', () => {
      const { result } = checkCondition(
        { condition: { type: 'dataEquals', path: 'counts', value: { pending: 0, completed: 2 } } },
        metaEvent({ counts: { completed: 2, pending: 0 } }),
        createSessionState(), log,
      )
      assert.equal(result, true)
    })

    it('dataNumberAtLeast matches a numeric threshold', () => {
      const { result } = checkCondition(
        { condition: { type: 'dataNumberAtLeast', path: 'counts.completed', value: 3 } },
        metaEvent({ counts: { completed: 3 } }),
        createSessionState(), log,
      )
      assert.equal(result, true)
    })

    it('dataNumberAtLeast is not applicable for a non-numeric resolved value', () => {
      const { applicable } = checkCondition(
        { condition: { type: 'dataNumberAtLeast', path: 'counts.completed', value: 3 } },
        metaEvent({ counts: { completed: 'three' } }),
        createSessionState(), log,
      )
      assert.equal(applicable, false)
    })

    it('an unresolvable path is not applicable, not false', () => {
      const { result, applicable } = checkCondition(
        { condition: { type: 'dataArrayNonEmpty', path: 'todos' } },
        metaEvent({}, 'bash'),
        createSessionState(), log,
      )
      assert.equal(applicable, false)
      assert.equal(result, false)
    })

    it('null toolMetadata (e.g. a failed tool call) is not applicable', () => {
      const { applicable } = checkCondition(
        { condition: { type: 'dataArrayNonEmpty', path: 'todos' } },
        metaEvent(null),
        createSessionState(), log,
      )
      assert.equal(applicable, false)
    })

    it("tool scoping makes an unrelated tool's completion not applicable", () => {
      const { applicable } = checkCondition(
        { condition: { type: 'dataArrayNonEmpty', path: 'todos', tool: 'todowrite' } },
        metaEvent({ todos: [{ status: 'pending' }] }, 'bash'),
        createSessionState(), log,
      )
      assert.equal(applicable, false)
    })

    it('toolIn scoping accepts any listed tool', () => {
      const { applicable, result } = checkCondition(
        { condition: { type: 'dataArrayNonEmpty', path: 'todos', toolIn: ['todowrite', 'todoread'] } },
        metaEvent({ todos: [{ status: 'pending' }] }, 'todoread'),
        createSessionState(), log,
      )
      assert.equal(applicable, true)
      assert.equal(result, true)
    })
  })
})

describe('validateRules', () => {
  it('warns naming a removed legacy condition type, distinct from the generic unknown-type warning', () => {
    const log = makeLog()
    validateRules([{ id: 'r1', event: 'tool.execute.after', condition: { type: 'allTodosComplete' } }], log)
    assert.equal(log.calls.length, 1)
    assert.match(log.calls[0].msg, /"allTodosComplete"/)
    assert.match(log.calls[0].msg, /removed/)
  })

  it('warns for a rule targeting the removed todo.updated event', () => {
    const log = makeLog()
    validateRules([{ id: 'r1', event: 'todo.updated' }], log)
    assert.equal(log.calls.length, 1)
    assert.match(log.calls[0].msg, /"todo\.updated"/)
    assert.match(log.calls[0].msg, /no longer emitted/)
  })

  it('warns exactly once when both a removed condition type and the removed event apply', () => {
    const log = makeLog()
    validateRules([{ id: 'r1', event: 'todo.updated', condition: { type: 'allTodosComplete' } }], log)
    assert.equal(log.calls.length, 1)
  })

  it('warns for once/edge without a stable id', () => {
    const log = makeLog()
    validateRules([{ event: 'tool.execute.after', once: true }], log)
    assert.equal(log.calls.length, 1)
    assert.match(log.calls[0].msg, /once\/edge/)
  })

  it('warns for a malformed data condition (missing path)', () => {
    const log = makeLog()
    validateRules([{ id: 'r1', event: 'tool.execute.after', condition: { type: 'dataArrayNonEmpty' } }], log)
    assert.equal(log.calls.length, 1)
    assert.match(log.calls[0].msg, /"path"/)
  })

  it('does not warn for a fully-valid rule', () => {
    const log = makeLog()
    validateRules([{ id: 'r1', event: 'tool.execute.after', condition: { type: 'toolName', tool: 'bash' } }], log)
    assert.equal(log.calls.length, 0)
  })

  it('exports the removed legacy type/event sets', () => {
    assert.equal(REMOVED_LEGACY_CONDITION_TYPES.size, 9)
    assert.equal(REMOVED_LEGACY_EVENT_TYPES.has('todo.updated'), true)
  })
})

describe('buildFraming', () => {
  it('non-hidden framing does not include the non-disclosure clause', () => {
    const { system } = buildFraming({ instruction: 'do X', hidden: false })
    assert.doesNotMatch(system, /do not mention/i)
  })

  it('non-hidden framing avoids adversarial-sounding injection wording', () => {
    const { system } = buildFraming({ instruction: 'do X', hidden: false })
    assert.doesNotMatch(system, /injection/i)
    assert.doesNotMatch(system, /reveal/i)
  })

  it('hidden framing includes the non-disclosure clause', () => {
    const { system } = buildFraming({ instruction: 'do X', hidden: true })
    assert.match(system, /do not mention/i)
  })

  it('hidden framing avoids adversarial-sounding injection wording', () => {
    const { system } = buildFraming({ instruction: 'do X', hidden: true })
    assert.doesNotMatch(system, /injection/i)
    assert.doesNotMatch(system, /reveal/i)
  })

  it('text carries the framing prepended to the instruction (for runtimes with no system field)', () => {
    const { system, text } = buildFraming({ instruction: 'do X', hidden: false })
    assert.equal(text, `${system}\n\ndo X`)
  })
})

describe('evaluate', () => {
  it('a matching rule produces exactly one decision', () => {
    const rules = [{ id: 'r1', event: 'session.created', instruction: 'hello' }]
    const nev = { kind: 'session.created', sessionID: 's1' }
    const decisions = evaluate(rules, nev, 'build', createSessionState(), makeLog(), false)
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].rule.id, 'r1')
  })

  it('a rule with no instruction produces no decision', () => {
    const rules = [{ id: 'r1', event: 'session.created' }]
    const nev = { kind: 'session.created', sessionID: 's1' }
    const decisions = evaluate(rules, nev, 'build', createSessionState(), makeLog(), false)
    assert.equal(decisions.length, 0)
  })

  it('an unresolved agent fails a specific agent filter', () => {
    const rules = [{ id: 'r1', event: 'session.created', agents: 'build', instruction: 'i1' }]
    const nev = { kind: 'session.created', sessionID: 's1' }
    const decisions = evaluate(rules, nev, null, createSessionState(), makeLog(), false)
    assert.equal(decisions.length, 0)
  })

  it('a not-applicable condition does not fire and does not update once/edge state', () => {
    const rules = [{
      id: 'r1', event: 'tool.execute.after', instruction: 'i1',
      condition: { type: 'dataArrayNonEmpty', path: 'todos' }, edge: 'rise',
    }]
    const state = createSessionState()
    const nev = { kind: 'tool.execute.after', sessionID: 's1', toolName: 'bash', toolMetadata: {} }
    const decisions = evaluate(rules, nev, 'build', state, makeLog(), false)
    assert.equal(decisions.length, 0)
    assert.equal(state.modifierState.has('r1'), false)
  })

  describe('once modifier', () => {
    it('once fires only the first time', () => {
      const rules = [{
        id: 'r1', event: 'tool.execute.after', instruction: 'i1', once: true,
        condition: { type: 'dataArrayNonEmpty', path: 'todos' },
      }]
      const state = createSessionState()
      const nev = { kind: 'tool.execute.after', sessionID: 's1', toolName: 'todowrite', toolMetadata: { todos: [{ status: 'pending' }] } }
      const first = evaluate(rules, nev, 'build', state, makeLog(), false)
      assert.equal(first.length, 1)
      const second = evaluate(rules, nev, 'build', state, makeLog(), false)
      assert.equal(second.length, 0)
    })

    it('is ignored (rule behaves unmodified) when the rule has no id', () => {
      const rules = [{
        event: 'tool.execute.after', instruction: 'i1', once: true,
        condition: { type: 'dataArrayNonEmpty', path: 'todos' },
      }]
      const state = createSessionState()
      const nev = { kind: 'tool.execute.after', sessionID: 's1', toolName: 'todowrite', toolMetadata: { todos: [{ status: 'pending' }] } }
      const first = evaluate(rules, nev, 'build', state, makeLog(), false)
      const second = evaluate(rules, nev, 'build', state, makeLog(), false)
      assert.equal(first.length, 1)
      assert.equal(second.length, 1, 'without an id, once has no effect -- the rule fires every time')
    })

    it('condition-less rule with once fires once per session', () => {
      const rules = [{ id: 'r3', event: 'tool.execute.after', instruction: 'i1', once: true }]
      const state = createSessionState()
      const nev = { kind: 'tool.execute.after', sessionID: 's1', toolName: 'bash', toolMetadata: null }
      const first = evaluate(rules, nev, 'build', state, makeLog(), false)
      const second = evaluate(rules, nev, 'build', state, makeLog(), false)
      assert.equal(first.length, 1)
      assert.equal(second.length, 0)
    })
  })

  describe('edge modifier', () => {
    it('edge rise fires only on a false-to-true transition', () => {
      const rules = [{
        id: 'r2', event: 'tool.execute.after', instruction: 'i1', edge: 'rise',
        condition: { type: 'dataArrayNonEmpty', path: 'todos' },
      }]
      const state = createSessionState()
      const empty = { kind: 'tool.execute.after', sessionID: 's1', toolName: 'todowrite', toolMetadata: { todos: [] } }
      const nonEmpty = { kind: 'tool.execute.after', sessionID: 's1', toolName: 'todowrite', toolMetadata: { todos: [{ status: 'pending' }] } }
      assert.equal(evaluate(rules, empty, 'build', state, makeLog(), false).length, 0)
      assert.equal(evaluate(rules, nonEmpty, 'build', state, makeLog(), false).length, 1, 'rises on first non-empty')
      assert.equal(evaluate(rules, nonEmpty, 'build', state, makeLog(), false).length, 0, 'does not re-fire while still non-empty')
    })

    it('fall fires only on a true-to-false transition', () => {
      const rules = [{
        id: 'r2', event: 'tool.execute.after', instruction: 'i1', edge: 'fall',
        condition: { type: 'dataArrayNonEmpty', path: 'todos' },
      }]
      const state = createSessionState()
      state.modifierState.set('r2', { lastMatch: true, fired: false })
      const empty = { kind: 'tool.execute.after', sessionID: 's1', toolName: 'todowrite', toolMetadata: { todos: [] } }
      assert.equal(evaluate(rules, empty, 'build', state, makeLog(), false).length, 1)
    })

    it('condition-less rule with edge rise fires only on the first event', () => {
      const rules = [{ id: 'r4', event: 'tool.execute.after', instruction: 'i1', edge: 'rise' }]
      const state = createSessionState()
      const nev = { kind: 'tool.execute.after', sessionID: 's1', toolName: 'bash', toolMetadata: null }
      assert.equal(evaluate(rules, nev, 'build', state, makeLog(), false).length, 1)
      assert.equal(evaluate(rules, nev, 'build', state, makeLog(), false).length, 0)
    })
  })

  it('Transition conditions see a consistent prev/current pair across rules in one event', () => {
    const rules = [
      { id: 'ra', event: 'tool.execute.after', instruction: 'i1', edge: 'rise', condition: { type: 'toolName', tool: 'todowrite' } },
      { id: 'rb', event: 'tool.execute.after', instruction: 'i2', edge: 'fall', condition: { type: 'toolName', tool: 'todowrite' } },
    ]
    const state = createSessionState()
    const nev = { kind: 'tool.execute.after', sessionID: 's1', toolName: 'todowrite', toolMetadata: {} }
    const decisions = evaluate(rules, nev, 'build', state, makeLog(), false)
    assert.deepEqual(decisions.map(d => d.rule.id).sort(), ['ra'])
  })
})

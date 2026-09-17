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
  buildFraming,
  evaluate,
  createSessionState,
  resolveConfigPath,
  V2_UNSUPPORTED_CONDITION_TYPES,
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

describe('checkCondition', () => {
  const log = makeLog()

  it('no condition always matches', () => {
    const { result } = checkCondition({}, {}, createSessionState(), log)
    assert.equal(result, true)
  })

  it('allTodosComplete matches when all todos are completed and non-empty', () => {
    const nev = { todos: [{ status: 'completed' }, { status: 'completed' }] }
    const { result } = checkCondition({ condition: { type: 'allTodosComplete' } }, nev, createSessionState(), log)
    assert.equal(result, true)
  })

  it('allTodosComplete is false on an empty list ("all of none")', () => {
    const nev = { todos: [] }
    const { result } = checkCondition({ condition: { type: 'allTodosComplete' } }, nev, createSessionState(), log)
    assert.equal(result, false)
  })

  it('anyTodosComplete matches when at least one todo is completed', () => {
    const nev = { todos: [{ status: 'pending' }, { status: 'completed' }] }
    const { result } = checkCondition({ condition: { type: 'anyTodosComplete' } }, nev, createSessionState(), log)
    assert.equal(result, true)
  })

  it('noTodosInProgress matches when nothing is in_progress', () => {
    const nev = { todos: [{ status: 'completed' }] }
    const { result } = checkCondition({ condition: { type: 'noTodosInProgress' } }, nev, createSessionState(), log)
    assert.equal(result, true)
  })

  it('hasTodos matches on a non-empty list', () => {
    const { result: yes } = checkCondition({ condition: { type: 'hasTodos' } }, { todos: [{ status: 'pending' }] }, createSessionState(), log)
    const { result: no } = checkCondition({ condition: { type: 'hasTodos' } }, { todos: [] }, createSessionState(), log)
    assert.equal(yes, true)
    assert.equal(no, false)
  })

  it('todoListCreated matches on empty-to-non-empty transition', () => {
    const state = createSessionState()
    state.prevTodos = []
    const { result } = checkCondition({ condition: { type: 'todoListCreated' } }, { todos: [{ status: 'pending' }] }, state, log)
    assert.equal(result, true)
  })

  it('todoListCleared matches on non-empty-to-empty transition', () => {
    const state = createSessionState()
    state.prevTodos = [{ status: 'completed' }]
    const { result } = checkCondition({ condition: { type: 'todoListCleared' } }, { todos: [] }, state, log)
    assert.equal(result, true)
  })

  it('firstTodoStarted matches on the first transition to in_progress', () => {
    const state = createSessionState()
    state.prevTodos = [{ status: 'pending' }]
    const { result } = checkCondition({ condition: { type: 'firstTodoStarted' } }, { todos: [{ status: 'in_progress' }] }, state, log)
    assert.equal(result, true)
  })

  it('allTodosCompleteOnce fires once, then not again for the same session', () => {
    const state = createSessionState()
    const nev = { todos: [{ status: 'completed' }] }
    const first = checkCondition({ condition: { type: 'allTodosCompleteOnce' } }, nev, state, log)
    assert.equal(first.result, true)
    state.allTodosCompleteOnceFired = true // caller (evaluate) commits this post-loop
    const second = checkCondition({ condition: { type: 'allTodosCompleteOnce' } }, nev, state, log)
    assert.equal(second.result, false)
  })

  it('todoCountAtLeast defaults to 1 when count is missing or non-numeric', () => {
    const { result: withOne } = checkCondition({ condition: { type: 'todoCountAtLeast' } }, { todos: [{ status: 'pending' }] }, createSessionState(), log)
    assert.equal(withOne, true)
    const { result: withZero } = checkCondition({ condition: { type: 'todoCountAtLeast' } }, { todos: [] }, createSessionState(), log)
    assert.equal(withZero, false)
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
    const { result } = checkCondition({ condition: { type: 'notReal' } }, {}, createSessionState(), localLog)
    assert.equal(result, false)
    assert.equal(localLog.calls[0].level, 'warn')
  })
})

describe('buildFraming', () => {
  it('non-hidden framing does not include the non-disclosure clause', () => {
    const { system } = buildFraming({ instruction: 'do X', hidden: false })
    assert.doesNotMatch(system, /Do not reveal/)
  })

  it('hidden framing includes the non-disclosure clause', () => {
    const { system } = buildFraming({ instruction: 'do X', hidden: true })
    assert.match(system, /Do not reveal/)
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

  it('two transition rules in one event see the same prev/current pair', () => {
    const rules = [
      { id: 'created', event: 'todo.updated', condition: { type: 'todoListCreated' }, instruction: 'i1' },
      { id: 'cleared', event: 'todo.updated', condition: { type: 'todoListCleared' }, instruction: 'i2' },
    ]
    const state = createSessionState()
    state.prevTodos = [{ status: 'completed' }]
    // Current event: list went from non-empty to empty AND is being compared
    // fresh for both rules -- todoListCreated must NOT match (current is
    // empty, not created), todoListCleared MUST match.
    const nev = { kind: 'todo.updated', sessionID: 's1', todos: [] }
    const decisions = evaluate(rules, nev, 'build', state, makeLog(), false)
    assert.deepEqual(decisions.map(d => d.rule.id), ['cleared'])
  })

  it('prevTodos and allTodosCompleteOnceFired commit only after the full rule pass', () => {
    const rules = [{ id: 'r1', event: 'todo.updated', condition: { type: 'allTodosCompleteOnce' }, instruction: 'i1' }]
    const state = createSessionState()
    const nev = { kind: 'todo.updated', sessionID: 's1', todos: [{ status: 'completed' }] }
    const first = evaluate(rules, nev, 'build', state, makeLog(), false)
    assert.equal(first.length, 1, 'fires the first time')
    assert.equal(state.allTodosCompleteOnceFired, true, 'committed after the pass')
    const second = evaluate(rules, nev, 'build', state, makeLog(), false)
    assert.equal(second.length, 0, 'does not fire again')
  })

  it('an unresolved agent fails a specific agent filter', () => {
    const rules = [{ id: 'r1', event: 'session.created', agents: 'build', instruction: 'i1' }]
    const nev = { kind: 'session.created', sessionID: 's1' }
    const decisions = evaluate(rules, nev, null, createSessionState(), makeLog(), false)
    assert.equal(decisions.length, 0)
  })
})

describe('V2_UNSUPPORTED_CONDITION_TYPES', () => {
  it('lists exactly the 9 todo-derived types (toolName/toolNameIn are supported via ctx.tool.hook)', () => {
    assert.deepEqual(
      [...V2_UNSUPPORTED_CONDITION_TYPES].sort(),
      [
        'allTodosComplete', 'allTodosCompleteOnce', 'anyTodosComplete',
        'firstTodoStarted', 'hasTodos', 'noTodosInProgress', 'todoCountAtLeast',
        'todoListCleared', 'todoListCreated',
      ].sort(),
    )
    assert.equal(V2_UNSUPPORTED_CONDITION_TYPES.has('messageFinished'), false)
    assert.equal(V2_UNSUPPORTED_CONDITION_TYPES.has('toolName'), false)
    assert.equal(V2_UNSUPPORTED_CONDITION_TYPES.has('toolNameIn'), false)
  })
})

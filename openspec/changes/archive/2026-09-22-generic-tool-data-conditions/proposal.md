# Proposal

## Why

`opencode-auto-instruct`'s nine todo-derived condition types (`allTodosComplete`,
`anyTodosComplete`, `noTodosInProgress`, `hasTodos`, `todoListCreated`,
`todoListCleared`, `firstTodoStarted`, `allTodosCompleteOnce`,
`todoCountAtLeast`) are hardcoded to V1's native `todo.updated` event and its
`todos` payload shape. V2 has no such event, and the plugin explicitly
documents these types as permanently unsupported on V2 (see
`openspec/specs/rule-based-instruction-injection/spec.md`, "V2 event source
and current limitation for todo-derived conditions").

A separate, unrelated plugin (`opencode-todo`) has since reintroduced
`todowrite`/`todoread` as real tools on V2, each returning a structured
metadata payload (`{todos, counts, revision, ...}`) on its tool-call result.
This makes todo-derived conditions representable again on V2 — but not by
teaching `opencode-auto-instruct` about `opencode-todo` specifically. This
plugin must stay tool-agnostic: any tool that returns structured metadata on
its result should be usable as a condition source, described entirely in
rule *configuration* (dot-paths and predicates over that metadata), with zero
plugin code that knows about any specific tool or its schema.

Investigating the tool-event path also surfaced a **pre-existing, unrelated
bug**: V1's `normalize()` matches on `event.type === 'tool.execute.after'`,
but V1 never emits a generic-event-bus event with that `type` string —
`tool.execute.after` only exists as a separate Hooks-object registration key,
which `plugin.v1.js` never registers. The current `toolName`/`toolNameIn`
conditions have therefore never actually fired on V1. The real source of a
completed tool call on V1 is `message.part.updated` where
`properties.part.type === 'tool'` and `properties.part.state.status ===
'completed'`; `properties.part.state.metadata` is V1's equivalent of V2's
`result.metadata`. This fix is required to build the generic mechanism at
all (both runtimes need real tool-completion events with a metadata payload
attached), so it belongs in this change rather than a separate one.

## What Changes

- **BREAKING**: Remove the nine todo-derived condition types
  (`allTodosComplete`, `anyTodosComplete`, `noTodosInProgress`, `hasTodos`,
  `todoListCreated`, `todoListCleared`, `firstTodoStarted`,
  `allTodosCompleteOnce`, `todoCountAtLeast`) and the `todo.updated`
  event-kind handling that backed them (including `sessionState.prevTodos`
  tracking). No deprecation shim; callers relying on these types must migrate
  their rule configuration.
- Add a generic, tool-agnostic condition mechanism operating on a common
  `toolMetadata` field of the normalized event (populated by each runtime
  adapter from its own tool-completion event, only on successful
  completion): dot-path resolution (e.g. `path: "todos"`, `path:
  "counts.completed"`) plus predicates over the resolved value
  (`dataArrayEmpty`, `dataArrayNonEmpty`, `dataArrayLengthAtLeast`,
  `dataArrayAllMatch`, `dataArrayAnyMatch`, `dataArrayNoneMatch`,
  `dataEquals`).
- Add two rule-level, orthogonal modifiers — `once: true` (fire at most once
  per session) and `edge: "rise" | "fall"` (fire only on a false→true or
  true→false transition of the condition, replacing the ad hoc
  `todoListCreated`/`todoListCleared`/`firstTodoStarted`/
  `allTodosCompleteOnce` semantics generically for any condition).
- Fix V1's tool-completion detection: normalize from `message.part.updated`
  events (`part.type === 'tool'`, `part.state.status === 'completed'`)
  instead of the non-existent `tool.execute.after` generic event, extracting
  `toolName` from `part.tool` and `toolMetadata` from `part.state.metadata`.
  This makes `toolName`/`toolNameIn` actually fire on V1 for the first time.
- Extend V2's existing `ctx.tool.hook('execute.after', ...)` normalization to
  also read `toolEvent.result?.metadata` (only when `status === 'completed'`)
  into the same common `toolMetadata` field — currently discarded entirely.
- No changes to `opencode-todo` are required: its existing tool-result
  metadata shape (`{todos, counts, revision, ...}`) is already sufficient as
  a generic-mechanism data source once addressed via dot-path/predicate rule
  configuration.

## Capabilities

### Modified Capabilities

- `rule-based-instruction-injection`: the "Condition Evaluation" requirement
  changes from a fixed, todo-specific condition vocabulary plus V1-only
  transition tracking to a generic, tool-agnostic data-path/predicate
  mechanism with orthogonal `once`/`edge` modifiers, backed by a corrected
  tool-completion event source on both runtimes.

## Impact

- `src/core.js`: `V2_UNSUPPORTED_CONDITION_TYPES`, `V2_UNSUPPORTED_EVENT_TYPES`,
  the 9-arm todo-derived `checkCondition` switch cases, and
  `sessionState.prevTodos` tracking are removed. New dot-path resolver,
  predicate evaluators, and `once`/`edge` modifier handling are added.
  `NormalizedEvent` gains `toolMetadata`.
- `src/plugin.v1.js`: tool-completion normalization is rewritten from the
  no-op `tool.execute.after` generic-event match to `message.part.updated`
  handling.
- `src/plugin.v2.js`: `normalizeToolEvent()` is extended to read
  `toolEvent.result?.metadata`.
- `README.md`, `docs/v2-compat-audit.md`: updated to document the new
  condition schema and remove now-inaccurate claims about V1's
  `tool.execute.after` event and V2's permanent todo-condition gap.
- Downstream consumer `ai-dotfiles` (`dot_config/opencode/auto-instruct.json.tmpl`)
  will need its 4 existing rules rewritten to the new schema — tracked
  separately, out of scope for this change's `tasks.md`.
- `package.json`: version bump reflecting the breaking change.

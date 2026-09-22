# rule-based-instruction-injection Specification

## Purpose
TBD - created by archiving change v2-plugin-migration. Update Purpose after archive.

## Requirements

### Requirement: Rule Configuration Loading

The plugin SHALL load rules from a fixed config file
(`~/.config/opencode/auto-instruct.json`) and from the plugin's own options
(as configured in `opencode.jsonc`'s plugin block), merging file rules
before option rules. A missing config file SHALL NOT be treated as an
error. A config file that fails to parse SHALL be logged as a warning and
treated as contributing no rules. A `debug: true` flag, settable in either
the file or the options, SHALL enable verbose per-event logging.

#### Scenario: Config file present and valid

- GIVEN a valid `auto-instruct.json` config file with one or more rules
- WHEN the plugin loads
- THEN those rules are available for matching, in file order

#### Scenario: Config file absent

- GIVEN no `auto-instruct.json` file exists
- WHEN the plugin loads
- THEN the plugin loads with zero file-sourced rules and does not log an error

#### Scenario: Config file present but invalid JSON

- GIVEN an `auto-instruct.json` file that is not valid JSON
- WHEN the plugin loads
- THEN the plugin logs a warning and treats the file as contributing no rules

#### Scenario: Rules from both file and options

- GIVEN a config file with rule A and plugin options with rule B
- WHEN the plugin loads
- THEN both rule A and rule B are available for matching, with rule A evaluated before rule B

### Requirement: Agent Filtering

A rule's `agents` field SHALL restrict which session agent the rule applies
to. Absent or `"*"` SHALL match any agent. A string SHALL match only that
agent. An array SHALL match any agent named in it. When a rule specifies an
agent filter and the session's agent name could not be resolved, the rule
SHALL NOT match.

#### Scenario: No agent filter

- GIVEN a rule with no `agents` field
- WHEN an event fires for a session with any resolved agent
- THEN the rule's agent filter passes

#### Scenario: Specific agent filter matches

- GIVEN a rule with `agents: "build"` and a session whose resolved agent is `"build"`
- WHEN the rule is evaluated
- THEN the agent filter passes

#### Scenario: Specific agent filter does not match

- GIVEN a rule with `agents: "build"` and a session whose resolved agent is `"plan"`
- WHEN the rule is evaluated
- THEN the agent filter fails and the rule does not match

#### Scenario: Agent list filter

- GIVEN a rule with `agents: ["build", "plan"]` and a session whose resolved agent is `"plan"`
- WHEN the rule is evaluated
- THEN the agent filter passes

### Requirement: Condition Evaluation

A rule's optional `condition` SHALL be evaluated against the triggering
event, normalized to a runtime-neutral shape, and (for `once`/`edge`
modifiers) the rule's own tracked prior state. An absent condition SHALL
always match. The plugin SHALL support the condition types: `messageFinished`,
`toolName`, `toolNameIn`, `dataArrayEmpty`, `dataArrayNonEmpty`,
`dataArrayLengthAtLeast`, `dataArrayAllMatch`, `dataArrayAnyMatch`,
`dataArrayNoneMatch`, `dataEquals`, `dataNumberAtLeast`. An unrecognized
condition type SHALL log a warning and SHALL NOT match.

**Tool-completion event source (both runtimes).** A completed tool call
normalizes to a single runtime-neutral event kind, `tool.execute.after`, on
both V1 and V2. On V1 this kind is synthesized from a `message.part.updated`
event whose `part.type` is `"tool"` and whose `part.state.status` is
`"completed"`, extracting `toolName` from `part.tool` and `toolMetadata`
from `part.state.metadata`; the plugin SHALL deduplicate repeated
`message.part.updated` deliveries for the same tool call so exactly one
normalized `tool.execute.after` event is produced per completed call. On V2
this kind is produced directly from the `execute.after` tool hook,
extracting `toolName` from the hook's `tool` field and `toolMetadata` from
`result.metadata` when the hook reports `status: "completed"`. On both
runtimes, `toolMetadata` SHALL be `null` for a failed/errored tool call, and
SHALL be sourced only from the metadata slot — never from the tool's output
or content.

**Tool-agnostic data conditions.** The eight `data*`-prefixed condition
types SHALL be evaluated against a rule-configured dot-path resolved
relative to the triggering event's `toolMetadata`, without any plugin-code
knowledge of any specific tool name or metadata schema — all such knowledge
SHALL live only in the rule's own configuration:

- `dataArrayEmpty` / `dataArrayNonEmpty`: the resolved path SHALL be an
  array; the condition matches when it is empty / non-empty respectively.
- `dataArrayLengthAtLeast: {path, count}`: matches when the resolved array's
  length is `>= count`.
- `dataArrayAllMatch` / `dataArrayAnyMatch` / `dataArrayNoneMatch`:
  `{path, field, value}`. For each element of the resolved array, `field`
  SHALL be resolved as a dot-path relative to that element (an empty string
  compares the element itself) and compared to `value` using the same
  deep-equality rule as `dataEquals`. `AllMatch` matches when every element
  satisfies the comparison, `AnyMatch` when at least one does, `NoneMatch`
  when none do.
- `dataEquals: {path, value}`: matches when the resolved value is deeply,
  structurally equal to `value` — primitives by strict equality, arrays and
  objects recursively by value, independent of object key order.
- `dataNumberAtLeast: {path, value}`: the resolved value SHALL be a number;
  matches when it is `>= value`.

Every `data*` condition MAY additionally carry an optional `tool: string` or
`toolIn: string[]` field, scoping the condition to event(s) whose `toolName`
matches. The dot-path resolver SHALL treat any path segment equal to
`__proto__`, `constructor`, or `prototype` as unresolvable rather than
traversing it.

**Tri-state resolution: not applicable.** For every `data*` condition, if
the configured `path` does not resolve to a defined value on the current
event — because `toolMetadata` is `null`, the path segment is absent, or an
optional `tool`/`toolIn` scoping field does not match the event's
`toolName` — the condition SHALL be treated as **not applicable**: it SHALL
NOT match, and it SHALL NOT update that rule's `once`/`edge` tracking state
for that event. This is distinct from the condition evaluating to `false`.

**`once` and `edge` rule modifiers.** A rule MAY declare `once: true` and/or
`edge: "rise" | "fall"`, orthogonal modifiers gating whether a matched
condition is honoured:

- `once: true` SHALL cause the rule to fire at most one time per session,
  tracked independently per rule and per session, and marked as fired only
  after all rules have been evaluated for that event (regardless of whether
  the rule's instruction delivery succeeded).
- `edge: "rise"` / `edge: "fall"` SHALL cause the rule to fire only when its
  condition's resolved boolean transitions from not-matching to matching
  (`rise`) or matching to not-matching (`fall`), compared against that
  rule's own previously stored boolean — never a shared, cross-rule
  snapshot.
- Both modifiers REQUIRE the rule to declare a stable `id`. A rule that sets
  either modifier without an `id` SHALL log one warning at load time and
  SHALL have the modifier(s) treated as absent for that rule (the rule
  otherwise continues to function normally).
- Per-rule `once`/`edge` state SHALL store only a boolean (the rule's last
  resolved match/no-match), never the resolved data value itself.
- Within a single normalized event, every rule's condition SHALL be
  evaluated against `once`/`edge` state as it stood before that event; all
  rules' `once`/`edge` state updates SHALL be committed together only after
  every rule has been evaluated for that event — so every rule sees a
  consistent prior state, unaffected by another rule's evaluation within
  the same event.
- A rule with no `condition` (always-true) combined with `once: true` SHALL
  fire on the first matching event of the rule's configured kind in the
  session and never again. Combined with `edge: "rise"`, such a rule SHALL
  fire only on the very first event of that kind in the session.

**Load-time validation.** At load time, the plugin SHALL log one warning
for each of: an unrecognized condition type; a missing or invalid `path` on
any `data*` condition; a missing `value`/`count` where required; a
malformed matcher on `dataArrayAllMatch`/`dataArrayAnyMatch`/
`dataArrayNoneMatch`; and a `once`/`edge` modifier declared without an
`id`. A rule whose condition `type` is one of the removed legacy names
(`allTodosComplete`, `anyTodosComplete`, `noTodosInProgress`, `hasTodos`,
`todoListCreated`, `todoListCleared`, `firstTodoStarted`,
`allTodosCompleteOnce`, `todoCountAtLeast`) SHALL receive a warning distinct
from the generic unrecognized-type warning, naming the removed type. A rule
whose `event` is `"todo.updated"` SHALL similarly receive a distinct
warning stating that event kind is no longer emitted on any runtime.

#### Scenario: Unconditional rule always matches

- GIVEN a rule with no `condition` field
- WHEN any event of the rule's configured type fires
- THEN the rule matches

#### Scenario: toolName fires on V1 via the real message.part.updated path

- GIVEN a V1 `message.part.updated` event whose `part.type` is `"tool"`,
  `part.tool` is `"bash"`, and `part.state.status` is `"completed"`
- WHEN a rule with `condition: {type: "toolName", tool: "bash"}` is
  evaluated, with no data condition present
- THEN the condition matches, proving the tool-completion normalization
  fix independently of the data-condition mechanism

#### Scenario: toolNameIn matches a tool-hook event on V2

- GIVEN a V2 `execute.after` tool-hook event reporting `tool: "read"` and
  `status: "completed"`
- WHEN a rule with `condition: {type: "toolNameIn", tools: ["read", "edit"]}`
  is evaluated
- THEN the condition matches

#### Scenario: dataArrayNonEmpty matches a non-empty resolved array

- GIVEN a completed tool call whose `toolMetadata` resolves `"todos"` to a
  non-empty array
- WHEN a rule with `condition: {type: "dataArrayNonEmpty", path: "todos"}`
  is evaluated
- THEN the condition matches

#### Scenario: dataArrayAllMatch matches when every element satisfies the field comparison

- GIVEN a completed tool call whose `toolMetadata` resolves `"todos"` to
  `[{status: "completed"}, {status: "completed"}]`
- WHEN a rule with `condition: {type: "dataArrayAllMatch", path: "todos", field: "status", value: "completed"}` is evaluated
- THEN the condition matches

#### Scenario: dataArrayAnyMatch matches when at least one element satisfies the field comparison

- GIVEN a completed tool call whose `toolMetadata` resolves `"todos"` to
  `[{status: "pending"}, {status: "in_progress"}]`
- WHEN a rule with `condition: {type: "dataArrayAnyMatch", path: "todos", field: "status", value: "in_progress"}` is evaluated
- THEN the condition matches

#### Scenario: dataArrayNoneMatch matches when no element satisfies the field comparison

- GIVEN a completed tool call whose `toolMetadata` resolves `"todos"` to
  `[{status: "completed"}, {status: "completed"}]`
- WHEN a rule with `condition: {type: "dataArrayNoneMatch", path: "todos", field: "status", value: "pending"}` is evaluated
- THEN the condition matches

#### Scenario: dataEquals uses deep equality independent of key order

- GIVEN a completed tool call whose `toolMetadata` resolves `"counts"` to
  `{completed: 2, pending: 0}`
- WHEN a rule with `condition: {type: "dataEquals", path: "counts", value: {pending: 0, completed: 2}}` is evaluated
- THEN the condition matches

#### Scenario: dataNumberAtLeast matches a numeric threshold

- GIVEN a completed tool call whose `toolMetadata` resolves `"counts.completed"` to `3`
- WHEN a rule with `condition: {type: "dataNumberAtLeast", path: "counts.completed", value: 3}` is evaluated
- THEN the condition matches

#### Scenario: An unresolvable path is not applicable, not false

- GIVEN a completed tool call whose `toolMetadata` does not contain the
  path `"todos"` (e.g. the completed tool was `bash`, not a todo tool)
- WHEN a rule with `condition: {type: "dataArrayNonEmpty", path: "todos"}`
  and `edge: "rise"` is evaluated
- THEN the condition does not match, and the rule's stored prior boolean is
  left unchanged for the next event

#### Scenario: tool scoping makes an unrelated tool's completion not applicable

- GIVEN a completed tool call for `"bash"` whose `toolMetadata` happens to
  contain a `"todos"` key
- WHEN a rule with `condition: {type: "dataArrayNonEmpty", path: "todos", tool: "todowrite"}` is evaluated
- THEN the condition is not applicable and does not match

#### Scenario: once fires only the first time

- GIVEN a rule with `id: "r1"`, `once: true`, and a condition that already
  fired once in this session
- WHEN a subsequent event again satisfies the condition
- THEN the rule does not fire again for this session

#### Scenario: once or edge without an id logs a warning and is ignored

- GIVEN a rule with `once: true` and no `id` field
- WHEN the plugin loads
- THEN the plugin logs a warning naming the rule and treats `once` as
  absent for that rule, while the rule otherwise continues to function

#### Scenario: edge rise fires only on a false-to-true transition

- GIVEN a rule with `id: "r2"` and `edge: "rise"` whose condition
  previously evaluated to not-matching for this session
- WHEN an event's condition now evaluates to matching
- THEN the rule fires; a subsequent event that again evaluates to matching
  does not re-fire the rule

#### Scenario: Transition conditions see a consistent prev/current pair across rules in one event

- GIVEN two rules with `edge` modifiers evaluated against the same
  normalized event
- WHEN both rules are evaluated for that single event
- THEN both see the same pre-event stored boolean, not one already updated
  by the other rule's evaluation

#### Scenario: Condition-less rule with once fires once per session

- GIVEN a rule with `id: "r3"`, no `condition`, and `once: true`
- WHEN the rule's configured event kind fires twice in one session
- THEN the rule fires on the first occurrence only

#### Scenario: Condition-less rule with edge rise fires only on the first event

- GIVEN a rule with `id: "r4"`, no `condition`, and `edge: "rise"`
- WHEN the rule's configured event kind fires twice in one session
- THEN the rule fires on the first occurrence only

#### Scenario: messageFinished does not match a failed/errored finish

- GIVEN the nearest V2 event to `message.updated` reporting an error/failure finish status
- WHEN a rule with `condition: {type: "messageFinished"}` is evaluated on V2
- THEN the condition does not match

#### Scenario: Unrecognized condition type

- GIVEN a rule with `condition: {type: "notARealCondition"}`
- WHEN the rule is evaluated
- THEN the plugin logs a warning and the rule does not match

#### Scenario: allTodosComplete matches when all todos are completed (V1)

- GIVEN a rule with `condition: {type: "allTodosComplete"}` and a completed
  tool call whose `toolMetadata` shows every todo as `status: "completed"`
- WHEN the plugin loads
- THEN the plugin logs a warning naming `allTodosComplete` as a removed
  type, distinct from the generic unrecognized-type warning, and the rule
  never matches regardless of the todo data — it must be rewritten using
  `dataArrayAllMatch`/`dataNumberAtLeast` per the migration table

#### Scenario: Todo-derived conditions do not match on V2, and are logged at load

- GIVEN a rule with `condition: {type: "hasTodos"}`, running on V2
- WHEN the plugin loads
- THEN the plugin logs a warning naming `hasTodos` as a removed legacy
  type, and the rule never matches on V2 — the same is true on V1, since
  the type is removed on both runtimes, not V2-specific as before this
  change

#### Scenario: toolName matches a tool-hook event on V2

- GIVEN a V2 `execute.after` tool-hook event reporting `tool: "bash"` and
  `status: "completed"`
- WHEN a rule with `condition: {type: "toolName", tool: "bash"}` is
  evaluated
- THEN the condition matches

#### Scenario: allTodosCompleteOnce fires only the first time (V1)

- GIVEN a rule configured per the migration table as the replacement for
  `allTodosCompleteOnce` (a `dataArrayAllMatch` condition on `status:
  "completed"` combined with `once: true`) that already fired once in this
  session
- WHEN a subsequent completed tool call again shows all todos completed
- THEN the rule does not fire again for this session

#### Scenario: A rule targeting the removed todo.updated event logs a specific warning

- GIVEN a rule with `event: "todo.updated"`
- WHEN the plugin loads
- THEN the plugin logs a warning stating that event kind is no longer
  emitted on any runtime, and the rule never matches

### Requirement: Instruction Delivery

When a rule's event type, agent filter, and condition all match, and the
rule declares a non-empty `instruction`, the plugin SHALL deliver that
instruction into the session as a message the agent processes. The
delivered message SHALL be framed as an automated message generated by a
plugin configured on the agent, not typed by the user in this turn —
**on V1**, via a dedicated system-framing field; **on V2**, where the
delivery mechanism (`ctx.session.synthetic`) has no system-framing field, by
prepending the same framing text to the message body itself, so the
requirement holds identically regardless of which runtime carries it. The
framing text SHALL disclose the non-user-typed origin of the message without
using wording that resembles an adversarial instruction-injection attack
(e.g. it SHALL NOT describe itself as an "injection" or instruct the agent
to "reveal"/"not reveal" its existence); anchoring the wording to a
recognizable, benign pattern such as a system-generated reminder is
preferred. When `rule.hidden` is `true`, the framing SHALL additionally
instruct the agent not to mention this delivery to the user unless the user
specifically asks about it; on V2, hidden delivery SHALL also omit the
`description` field (source-confirmed, not documented in prose, to suppress
the message's visible row in the TUI — this is independently the
non-disclosure enforcement mechanism, which lives in the framing text
regardless of whether the visual hiding holds on a given build). When
`rule.noReply` is `true`, the plugin SHALL deliver the instruction without
triggering the agent to generate a response to it (V1: a dedicated no-reply
flag; V2: `resume: false`, the documented equivalent). When
`rule.switchToAgent` is set, the instruction SHALL be processed under that
named agent rather than the session's currently resolved agent — **on V1**,
this override is scoped to that one delivery only; **on V2**, no per-call
agent override exists (`ctx.session.prompt`/`ctx.session.synthetic` carry no
per-call agent field), so the plugin SHALL call
`ctx.session.switchAgent({sessionID, agent: rule.switchToAgent})` before
delivering the instruction, skipping that call when the target already
equals the resolved agent — this is a **persistent, session-level** change
on V2: the session remains on that agent for all subsequent turns, not just
the injected instruction, unlike V1's per-call scoping. The plugin SHALL
log this persistence once per session per rule, naming the previous agent.
A rule with no `instruction` SHALL NOT be delivered. A delivery failure
SHALL be logged and SHALL NOT prevent evaluation of subsequent rules for the
event.

#### Scenario: Matching rule delivers its instruction

- GIVEN a rule whose event, agent filter, and condition all match, with a non-empty `instruction`
- WHEN the triggering event fires
- THEN the plugin delivers the instruction into the session, framed as an automated, non-user-typed message

#### Scenario: Hidden rule adds non-disclosure framing

- GIVEN a matching rule with `hidden: true`
- WHEN its instruction is delivered
- THEN the framing additionally instructs the agent not to mention the delivery to the user unless asked

#### Scenario: noReply rule does not trigger a response

- GIVEN a matching rule with `noReply: true`
- WHEN its instruction is delivered
- THEN the agent does not generate a response to that delivery

#### Scenario: switchToAgent rule processes under a different agent on V1 (per-call only)

- GIVEN a matching rule with `switchToAgent: "review"` in a V1 session whose current agent is `"build"`
- WHEN its instruction is delivered
- THEN the instruction is processed under the `"review"` agent for that delivery only, and the session's agent for subsequent turns remains `"build"`

#### Scenario: switchToAgent rule persistently switches the session's agent on V2

- GIVEN a matching rule with `switchToAgent: "review"` in a V2 session whose current agent is `"build"`
- WHEN its instruction is delivered
- THEN the plugin calls `ctx.session.switchAgent` before delivery, and the session's agent for all subsequent turns becomes `"review"` — not reverting to `"build"` after the injected instruction

#### Scenario: Rule with no instruction is not delivered

- GIVEN a rule whose event, agent filter, and condition all match, but with no `instruction` field
- WHEN the triggering event fires
- THEN the plugin does not attempt delivery for that rule

#### Scenario: Delivery failure does not block subsequent rules

- GIVEN two matching rules for the same event, where the first rule's delivery fails
- WHEN the event is processed
- THEN the plugin logs the failure and still evaluates and attempts delivery for the second rule

### Requirement: Event-to-Session Resolution

The plugin SHALL extract a session ID from each incoming event's envelope
(V1: checking `event.properties.sessionID` then
`event.properties.info.id`, except for a `message.part.updated` event
carrying a completed tool part, whose session ID SHALL instead be read from
`event.properties.part.sessionID`; V2: from the event's `data.sessionID`).
An event with no resolvable session ID SHALL be skipped entirely (no rules
evaluated). The plugin SHALL resolve and cache each session's agent name,
seeded eagerly from a `session.created` event when available (V1:
`properties.info.agent`; V2: `data.agent`, read from the unwrapped
`ctx.session.get()` result, not a `.data`-nested one), and lazily fetched
otherwise; a resolution failure SHALL be treated as an unknown agent (fails
any specific agent filter, passes no filter).

#### Scenario: Event has a resolvable session ID (V1)

- GIVEN an event with `properties.sessionID` set
- WHEN the plugin processes the event
- THEN rule evaluation proceeds using that session ID

#### Scenario: Event has no resolvable session ID

- GIVEN an event with neither `properties.sessionID` nor `properties.info.id` set
- WHEN the plugin processes the event
- THEN no rules are evaluated for that event

#### Scenario: Agent name seeded from session.created

- GIVEN a `session.created` event carrying `properties.info.agent`
- WHEN the plugin processes the event
- THEN the session's agent name is cached from that event, avoiding a later lookup

#### Scenario: Session ID for a completed V1 tool part is read from the part itself

- GIVEN a `message.part.updated` event whose `part.type` is `"tool"`,
  `part.state.status` is `"completed"`, and `part.sessionID` is set (while
  the event's own `properties.sessionID` is absent)
- WHEN the plugin processes the event
- THEN rule evaluation proceeds using `part.sessionID`

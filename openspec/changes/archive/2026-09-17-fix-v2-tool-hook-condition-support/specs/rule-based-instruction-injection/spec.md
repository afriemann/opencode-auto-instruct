## MODIFIED Requirements

### Requirement: Condition Evaluation

A rule's optional `condition` SHALL be evaluated against the triggering
event, normalized to a runtime-neutral shape, and the session's tracked
todo-list state. An absent condition SHALL always match. The plugin SHALL
support the condition types: `allTodosComplete`, `anyTodosComplete`,
`noTodosInProgress`, `hasTodos`, `todoListCreated`, `todoListCleared`,
`firstTodoStarted`, `allTodosCompleteOnce`, `todoCountAtLeast`,
`messageFinished`, `toolName`, `toolNameIn`. Transition-detecting
conditions (`todoListCreated`, `todoListCleared`, `firstTodoStarted`) SHALL
compare the current event's todo list against the session's previously
recorded todo list, which SHALL be updated only after all rules have been
evaluated for that event — so every rule within one event sees the same
prev/current pair. `allTodosCompleteOnce` SHALL fire at most once per
session, tracked independently per session and marked as fired only after
the rule loop completes for that event. An unrecognized condition type
SHALL log a warning and SHALL NOT match.

**V1 event source.** All twelve condition types are evaluated against V1's
native `todo.updated`, `message.updated`, and `tool.execute.after` events,
whose payloads carry the todo list, message-finish status, and tool name
directly.

**V2 event source: `toolName`/`toolNameIn` are supported.** V2 exposes a
separate hook registration, `ctx.tool.hook("execute.after", callback)`
(distinct from `ctx.event.subscribe()`), that fires for every tool
invocation and carries the tool name, session ID, and agent directly. The
plugin SHALL evaluate `toolName` and `toolNameIn` against this hook's
events on V2, using the same matching semantics as V1.

**V2 event source and current limitation for todo-derived conditions.**
V2 has no server-side todo-management tool at all (confirmed by
exhaustively enumerating V2's built-in tool registrations — there is no
todo-creation or todo-read tool for any hook to observe, and no `todo.*`
event either). The nine todo-derived condition types (`allTodosComplete`,
`anyTodosComplete`, `noTodosInProgress`, `hasTodos`, `todoListCreated`,
`todoListCleared`, `firstTodoStarted`, `allTodosCompleteOnce`,
`todoCountAtLeast`) therefore have no event or tool-call source on V2 and
SHALL NOT match on that runtime; the plugin SHALL log one explicit warning
per affected rule at load time on V2, naming the rule and the reason,
rather than silently never firing. `messageFinished` SHALL be evaluated on
V2 using the nearest equivalent event's finish-status field, and SHALL
treat an error/failure finish status as a non-match (V1's semantics test
for a successful/normal finish, not merely "any finish occurred").
Recovering the nine todo-derived types would require V2 to gain a
server-side todo-management tool (or equivalent event) to observe in the
first place — this is outside the plugin's control and not a requirement
of this capability's current version.

#### Scenario: Unconditional rule always matches

- GIVEN a rule with no `condition` field
- WHEN any event of the rule's configured type fires
- THEN the rule matches

#### Scenario: allTodosComplete matches when all todos are completed (V1)

- GIVEN a `todo.updated` event whose todos are all `status: "completed"` and non-empty
- WHEN a rule with `condition: {type: "allTodosComplete"}` is evaluated
- THEN the condition matches

#### Scenario: Todo-derived conditions do not match on V2, and are logged at load

- GIVEN a rule with a todo-derived condition type, running on V2
- WHEN the plugin loads
- THEN the plugin logs one warning naming the rule and stating the condition type has no todo-management tool or event source on V2, and the rule never matches on that runtime

#### Scenario: toolName matches a tool-hook event on V2

- GIVEN a `ctx.tool.hook("execute.after", ...)` event reporting `tool: "bash"`
- WHEN a rule with `condition: {type: "toolName", tool: "bash"}` is evaluated on V2
- THEN the condition matches

#### Scenario: toolNameIn matches a tool-hook event on V2

- GIVEN a `ctx.tool.hook("execute.after", ...)` event reporting `tool: "read"`
- WHEN a rule with `condition: {type: "toolNameIn", tools: ["read", "edit"]}` is evaluated on V2
- THEN the condition matches

#### Scenario: messageFinished does not match a failed/errored finish

- GIVEN the nearest V2 event to `message.updated` reporting an error/failure finish status
- WHEN a rule with `condition: {type: "messageFinished"}` is evaluated on V2
- THEN the condition does not match

#### Scenario: allTodosCompleteOnce fires only the first time (V1)

- GIVEN a session where `allTodosCompleteOnce` already fired on a previous `todo.updated` event
- WHEN a subsequent `todo.updated` event again has all todos completed
- THEN the condition does not match again for that session

#### Scenario: Transition conditions see a consistent prev/current pair across rules in one event

- GIVEN two rules with `todoListCreated` and `todoListCleared` conditions evaluated against the same `todo.updated` event
- WHEN both rules are evaluated for that single event
- THEN both see the same "previous" todo snapshot (from before this event), not one already updated by the other rule's evaluation

#### Scenario: Unrecognized condition type

- GIVEN a rule with `condition: {type: "notARealCondition"}`
- WHEN the rule is evaluated
- THEN the plugin logs a warning and the rule does not match

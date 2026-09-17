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

### Requirement: Instruction Delivery

When a rule's event type, agent filter, and condition all match, and the
rule declares a non-empty `instruction`, the plugin SHALL deliver that
instruction into the session as a message the agent processes. The
delivered message SHALL be framed as an automated, non-user-typed
injection — **on V1**, via a dedicated system-framing field; **on V2**,
where the delivery mechanism (`ctx.session.synthetic`) has no system-framing
field, by prepending the same framing text to the message body itself, so
the requirement holds identically regardless of which runtime carries it.
When `rule.hidden` is `true`, the framing SHALL additionally state that the
injection's existence SHALL NOT be revealed to the user unless specifically
asked; on V2, hidden delivery SHALL also omit the `description` field
(source-confirmed, not documented in prose, to suppress the message's
visible row in the TUI — this is independently the non-disclosure
enforcement mechanism, which lives in the framing text regardless of
whether the visual hiding holds on a given build). When `rule.noReply` is
`true`, the plugin SHALL deliver the instruction without triggering the
agent to generate a response to it (V1: a dedicated no-reply flag; V2:
`resume: false`, the documented equivalent). When `rule.switchToAgent` is
set, the instruction SHALL be processed under that named agent rather than
the session's currently resolved agent — **on V1**, this override is scoped
to that one delivery only; **on V2**, no per-call agent override exists
(`ctx.session.prompt`/`ctx.session.synthetic` carry no per-call agent
field), so the plugin SHALL call
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
- THEN the plugin delivers the instruction into the session, framed as an automated injection

#### Scenario: Hidden rule adds non-disclosure framing

- GIVEN a matching rule with `hidden: true`
- WHEN its instruction is delivered
- THEN the framing additionally instructs the agent not to reveal the injection's existence unless asked

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
`event.properties.info.id`; V2: from the event's `data.sessionID`). An
event with no resolvable session ID SHALL be skipped entirely (no rules
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

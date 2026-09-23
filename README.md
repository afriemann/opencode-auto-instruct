# opencode-auto-instruct

opencode plugin that sends configurable instructions as real conversation messages when events occur in an agent session. Instructions appear as visible turns that the agent responds to explicitly.

## Install

Symlink into the global opencode plugins directory:

```bash
# V1 (`opencode-ai`/`@opencode-ai/plugin`)
ln -s ~/git/opencode-auto-instruct/src/plugin.v1.js \
      ~/.config/opencode/plugins/opencode-auto-instruct.js

# V2 (`@opencode/cli`/`@opencode/plugin`)
ln -s ~/git/opencode-auto-instruct/src/plugin.v2.js \
      ~/.config/opencode/plugins/opencode-auto-instruct.js
```

Or import via the package's `exports` map (`.`/`./v1` → `src/plugin.v1.js`, `./v2` → `src/plugin.v2.js`).

## Configuration

Create `~/.config/opencode/auto-instruct.json`:

```json
{
  "rules": [
    {
      "id":          "optional-identifier",
      "event":       "tool.execute.after",
      "agents":      ["engineer", "agent-engineer"],
      "condition":   { "type": "dataArrayAllMatch", "path": "todos", "field": "status", "value": "completed", "tool": "todowrite" },
      "once":        true,
      "instruction": "All your todos are marked complete. Before finishing, run through your quality checklist..."
    }
  ]
}
```

### Rule fields

| Field           | Type                      | Required | Description |
|-----------------|---------------------------|----------|-------------|
| `id`            | `string`                  | no       | Identifier shown in logs. **Required** if `once` or `edge` is set (see below) |
| `event`         | `string`                  | **yes**  | opencode event type to listen on |
| `agents`        | `string \| string[]`      | no       | Agent name(s) to match, or `"*"`. Absent = match all agents |
| `condition`     | `{ type, ...opts }`       | no       | Additional condition on the event. Absent = always match |
| `once`          | `boolean`                 | no       | Fire at most once per session (requires `id`) |
| `edge`          | `"rise" \| "fall"`        | no       | Fire only on a false→true (`rise`) or true→false (`fall`) transition of the condition (requires `id`) |
| `instruction`   | `string`                  | **yes**  | Text sent as a new conversation message to the agent |
| `switchToAgent` | `string`                  | no       | When set, switches the session to this agent before delivering the instruction. The new agent receives the instruction and responds under its own system prompt. The full conversation history is preserved — this is a mid-session handoff, not a fresh context. **V1/V2 divergence**: on V1 this override is scoped to the one delivery only, reverting afterward; on V2 it is a **persistent, session-level** switch — the session stays on the new agent for all subsequent turns. This makes V2 the better fit for a durable handoff (see the "Hand off to a different agent when work is done" example below); V1's per-delivery scoping is better suited to a one-off aside. See `docs/v2-compat-audit.md`. |
| `hidden`        | `boolean`                 | no       | When `true`, the instruction text is sent to the agent only — hidden from the user in the UI (default: `false`) |
| `noReply`       | `boolean`                 | no       | When `true`, the instruction is injected without triggering an agent response turn (default: `false`) |

> **V2 support**: this plugin also ships a V2 adapter (`opencode-auto-instruct/v2`,
> for `@opencode/cli`/`@opencode/plugin`). The condition vocabulary below is
> fully supported on both runtimes: `tool.execute.after` is a synthetic,
> runtime-neutral event emitted identically on V1 (from `message.part.updated`)
> and V2 (from `ctx.tool.hook('execute.after', ...)`), so one rule config works
> unchanged on either host. See `docs/v2-compat-audit.md` for the runtime
> mapping.

### Supported events

Any opencode event type works. Useful ones:

| Event                | Fired when |
|----------------------|------------|
| `session.idle`       | Agent finishes a turn and goes idle |
| `session.created`    | A new agent session starts |
| `message.updated`    | An agent message is updated |
| `tool.execute.after` | A tool call completes (synthetic, runtime-neutral — see above) |
| `file.edited`        | The agent edits a file |

### Conditions

Conditions filter events beyond just the event type. The plugin has **no
built-in knowledge of any specific tool** — every condition below operates
generically on whatever structured metadata a tool's result carries. To
condition on a specific tool's data (e.g. a todo-management tool's todo
list), point a `data*` condition at the dot-path within that tool's own
result metadata, and scope it with `tool`/`toolIn` if needed.

#### `message.updated` conditions

| Condition type    | Matches when |
|-------------------|--------------|
| `messageFinished` | Message `info.finish` is truthy |

#### `tool.execute.after` conditions

| Condition type | Matches when | Notes |
|----------------|--------------|-------|
| `toolName`     | `tool` field equals `condition.tool` | Exact match against one tool name |
| `toolNameIn`   | `tool` field is in `condition.tools` | Match any of a set; avoids duplicating rules |

**`toolName` options:**

```json
{ "type": "toolName", "tool": "bash" }
```

**`toolNameIn` options:**

```json
{ "type": "toolNameIn", "tools": ["bash", "todowrite"] }
```

#### Tool-agnostic data conditions

Every condition below resolves `path` (a dot-path, e.g. `"todos"` or
`"counts.completed"`) against the completed tool call's own result
metadata, and evaluates a predicate on the resolved value. If the path does
not resolve — because the completed tool didn't emit that metadata, or an
optional `tool`/`toolIn` scope doesn't match the event's tool — the
condition is **not applicable**: it does not match, and it does not update
`once`/`edge` tracking state. This makes every `data*` condition safe by
default against unrelated tool completions, even without `tool`/`toolIn`.

| Condition type | Required fields | Matches when |
|-----------------|-----------------|--------------|
| `dataArrayEmpty` | `path` | Resolved value is an array of length `0` |
| `dataArrayNonEmpty` | `path` | Resolved value is an array of length `> 0` |
| `dataArrayLengthAtLeast` | `path`, `count` | Resolved array's length `>= count` |
| `dataArrayAllMatch` | `path`, `field`, `value` | Every element's `field` (a dot-path relative to the element; `""` compares the element itself) deep-equals `value` |
| `dataArrayAnyMatch` | `path`, `field`, `value` | At least one element's `field` deep-equals `value` |
| `dataArrayNoneMatch` | `path`, `field`, `value` | No element's `field` deep-equals `value` |
| `dataEquals` | `path`, `value` | Resolved value deep-equals `value` (structural, key-order independent) |
| `dataNumberAtLeast` | `path`, `value` | Resolved value is a number `>= value` |

All eight types accept an optional `tool: string` or `toolIn: string[]`
field, restricting the condition to event(s) whose tool name matches:

```json
{ "type": "dataArrayNonEmpty", "path": "todos", "tool": "todowrite" }
```

`condition` is optional — omit it to match every occurrence of the event.

### `once` and `edge` rule modifiers

Both **require** the rule to declare a stable `id`; without one, the plugin
logs a load-time warning and the modifier is ignored for that rule (the
rule otherwise continues to work normally).

- `once: true` — the rule fires at most once per session, tracked
  independently per rule.
- `edge: "rise"` — the rule fires only when its condition transitions from
  not-matching to matching, compared against that rule's own previous
  state (never a shared, cross-rule snapshot).
- `edge: "fall"` — the mirror image: fires only on a matching→not-matching
  transition.

A rule with no `condition` (always-true) combined with `once: true` fires
on the first matching event in the session and never again; combined with
`edge: "rise"`, it fires only on the very first such event.

### Known limitation: `once`/`edge` state does not survive a restart

`once`/`edge` modifier state (whether a rule has already fired, and its last
resolved match/no-match) is tracked per rule ID in an in-memory `Map`, held
inside the plugin process for the lifetime of that process (`sessionStates`
in `plugin.v1.js`/`plugin.v2.js`, populated via `core.js`'s
`createSessionState`/`evaluate`). It is **not** persisted anywhere.

An opencode conversation session is file-backed and survives a service or
plugin restart, but this modifier state does not: a restart resets every
rule's tracked state to "never fired, no prior match" for every session,
even one that has been running for hours. The next matching event after a
restart is therefore indistinguishable from the *first* matching event in
that session — an `edge: "rise"` rule can re-fire on what looks to it like a
fresh false→true transition, and a `once: true` rule can fire again even
though it already fired earlier in the same conversation.

**Prefer a stateless condition over `edge`/`once` whenever the intent can be
expressed entirely from the current event's own data**, with no need to
compare against a *previous* event. Such conditions have no cross-restart
durability problem, because they hold no state to lose in the first place.

For example, "remind the agent right after it creates a todo list, but not
on every later call" does not actually require detecting a 0→N transition.
A freshly created list has every item still `pending` — nothing has been
started yet — so the same intent can be expressed as a condition that only
inspects the current call's data:

```json
{
  "id": "todo-list-created",
  "event": "tool.execute.after",
  "condition": { "type": "dataArrayAllMatch", "path": "todos", "field": "status", "value": "pending", "tool": "todowrite" },
  "instruction": "You have just created a todo list. Keep it accurate as you work: mark items `in_progress` before starting, `completed` immediately after finishing, and add newly-discovered follow-ups. Only one item should be `in_progress` at a time."
}
```

This fires only while every todo is still `pending` (i.e. before the agent
starts the first item) and stops matching the moment any item moves to
`in_progress` or `completed` — the same effective behavior as
`dataArrayNonEmpty` + `edge: "rise"`, but derived solely from the data in
each event rather than a transition tracked across events, so it is
unaffected by a mid-session restart.

`edge`/`once` remain the right tool when the intent genuinely cannot be
recovered from current data alone (e.g. "fire only the very first time this
condition is ever true, even if it later becomes false and true again in a
way indistinguishable from the data itself") — just budget for the
restart-durability gap above when choosing them.

### Migrating from the removed todo-derived condition types

The condition types `allTodosComplete`, `anyTodosComplete`,
`noTodosInProgress`, `hasTodos`, `todoListCreated`, `todoListCleared`,
`firstTodoStarted`, `allTodosCompleteOnce`, and `todoCountAtLeast` — along
with the `todo.updated` event — were **removed** in favor of the
tool-agnostic mechanism above. A rule using any of them logs a specific
load-time warning naming the removed type/event. The table below maps each
removed type to its replacement, assuming a todo-management tool whose
result metadata is shaped `{ todos: [{ status }], counts: {...} }` — this
shape is illustrative only; substitute your own tool's actual metadata
schema.

| Removed type | Replacement |
|---|---|
| `allTodosComplete` | `{ "type": "dataArrayAllMatch", "path": "todos", "field": "status", "value": "completed", "tool": "todowrite" }` |
| `anyTodosComplete` | `{ "type": "dataArrayAnyMatch", "path": "todos", "field": "status", "value": "completed", "tool": "todowrite" }` |
| `noTodosInProgress` | `{ "type": "dataArrayNoneMatch", "path": "todos", "field": "status", "value": "in_progress", "tool": "todowrite" }` |
| `hasTodos` | `{ "type": "dataArrayNonEmpty", "path": "todos", "tool": "todowrite" }` |
| `todoListCreated` | `{ "type": "dataArrayNonEmpty", "path": "todos", "tool": "todowrite" }` with `"edge": "rise"` |
| `todoListCleared` | `{ "type": "dataArrayEmpty", "path": "todos", "tool": "todowrite" }` with `"edge": "rise"` |
| `firstTodoStarted` | `{ "type": "dataArrayAnyMatch", "path": "todos", "field": "status", "value": "in_progress", "tool": "todowrite" }` with `"edge": "rise"` |
| `allTodosCompleteOnce` | same condition as `allTodosComplete` above, with `"once": true` |
| `todoCountAtLeast` | `{ "type": "dataNumberAtLeast", "path": "counts.total", "value": N, "tool": "todowrite" }` |

Every rule using a replacement above also needs `"id"` set, since both
`edge` and `once` require it.

### Agents filter

```json
"agents": "*"               // all agents (default when omitted)
"agents": "engineer"        // one specific agent
"agents": ["engineer", "agent-engineer"]  // any of these
```

### Multiple rules

Rules are evaluated in order. All matching rules fire; their instructions are queued and injected together on the agent's next LLM call.

File rules are loaded first; any rules passed via `opencode.jsonc` plugin options are appended.

### Timing

Instructions are injected on the **next LLM call** after the triggering event. For events like `tool.execute.after`, the agent almost always generates at least one more response (final summary, commit message, sign-off), so the instruction arrives at the right moment. Each instruction fires exactly once per trigger.

## Examples

### Remind the agent to keep todos up-to-date when it creates a list

```json
{
  "rules": [
    {
      "id": "todo-list-created",
      "event": "tool.execute.after",
      "agents": ["engineer"],
      "condition": { "type": "dataArrayNonEmpty", "path": "todos", "tool": "todowrite" },
      "edge": "rise",
      "instruction": "You have just created a todo list. Keep it accurate as you work: mark items `in_progress` before starting, `completed` immediately after finishing, and add newly-discovered follow-ups. Only one item should be `in_progress` at a time."
    }
  ]
}
```

### Quality checklist when all todos are done (fires once)

```json
{
  "rules": [
    {
      "id": "all-todos-done",
      "event": "tool.execute.after",
      "condition": { "type": "dataArrayAllMatch", "path": "todos", "field": "status", "value": "completed", "tool": "todowrite" },
      "once": true,
      "instruction": "All todos are complete. Run the quality checklist before finishing: tests pass, linters clean, no secrets committed, git status is clean."
    }
  ]
}
```

### Inject context when specific tools are called

```json
{
  "rules": [
    {
      "id": "git-reminder",
      "event": "tool.execute.after",
      "condition": { "type": "toolNameIn", "tools": ["bash", "execute_command"] },
      "instruction": "You just ran a shell command. If it was a git operation, verify the result with git status before proceeding."
    }
  ]
}
```

### Hand off to a different agent when work is done

When implementation todos are all complete, switch to the `code-reviewer` agent to review the changes before committing. The reviewer inherits the full session context — all tool calls, file edits, and conversation — so it can review without needing a separate summary.

```json
{
  "rules": [
    {
      "id": "review-on-completion",
      "event": "tool.execute.after",
      "agents": ["engineer"],
      "condition": { "type": "dataArrayAllMatch", "path": "todos", "field": "status", "value": "completed", "tool": "todowrite" },
      "once": true,
      "switchToAgent": "code-reviewer",
      "hidden": true,
      "instruction": "Implementation is complete. Review the changes made in this session and report any blockers or warnings before the engineer commits."
    }
  ]
}
```

The log will show `agent=engineer→code-reviewer` when the switch fires. The `agents` filter still controls which agent this rule fires *for* — `switchToAgent` controls where it routes *to*.

> **Note:** `switchToAgent` does a mid-session handoff, not a fresh subagent spawn. The new agent responds under its own system prompt but sees the entire prior conversation history. For isolated parallel work, use the `task` tool instead.

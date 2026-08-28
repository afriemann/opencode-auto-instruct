# opencode-auto-instruct

opencode plugin that sends configurable instructions as real conversation messages when events occur in an agent session. Instructions appear as visible turns that the agent responds to explicitly.

## Install

Symlink into the global opencode plugins directory:

```bash
mkdir -p ~/git/opencode-auto-instruct/node_modules/@opencode-ai
ln -s ~/.config/opencode/node_modules/@opencode-ai/plugin \
      ~/git/opencode-auto-instruct/node_modules/@opencode-ai/plugin
ln -s ~/git/opencode-auto-instruct/src/index.js \
      ~/.config/opencode/plugins/opencode-auto-instruct.js
```

## Configuration

Create `~/.config/opencode/auto-instruct.json`:

```json
{
  "rules": [
    {
      "id":          "optional-identifier",
      "event":       "todo.updated",
      "agents":      ["engineer", "agent-engineer"],
      "condition":   { "type": "allTodosComplete" },
      "instruction": "All your todos are marked complete. Before finishing, run through your quality checklist..."
    }
  ]
}
```

### Rule fields

| Field         | Type                      | Required | Description |
|---------------|---------------------------|----------|-------------|
| `id`          | `string`                  | no       | Identifier shown in logs |
| `event`       | `string`                  | **yes**  | opencode event type to listen on |
| `agents`      | `string \| string[]`      | no       | Agent name(s) to match, or `"*"`. Absent = match all agents |
| `condition`   | `{ type, ...opts }`       | no       | Additional condition on the event. Absent = always match |
| `instruction` | `string`                  | **yes**  | Text sent as a new conversation message to the agent |

### Supported events

Any opencode event type works. Useful ones:

| Event                | Fired when |
|----------------------|------------|
| `todo.updated`       | Agent updates its todo list |
| `session.idle`       | Agent finishes a turn and goes idle |
| `session.created`    | A new agent session starts |
| `message.updated`    | An agent message is updated |
| `tool.execute.after` | A tool call completes |
| `file.edited`        | The agent edits a file |

### Conditions

Conditions filter events beyond just the event type.

#### `todo.updated` conditions

| Condition type         | Matches when | Notes |
|------------------------|--------------|-------|
| `allTodosComplete`     | All todos have status `"completed"` | Re-fires on every update while all todos remain complete |
| `allTodosCompleteOnce` | All todos have status `"completed"` | Fires **at most once per session** — use instead of `allTodosComplete` to avoid repeated triggers |
| `anyTodosComplete`     | At least one todo has status `"completed"` | |
| `noTodosInProgress`    | No todo has status `"in_progress"` | |
| `hasTodos`             | Todo list is non-empty | Re-fires on every update while the list is non-empty |
| `todoListCreated`      | List transitions from empty → non-empty | Fires **once per session** on first todo creation |
| `todoListCleared`      | List transitions from non-empty → empty | Fires when the agent wipes all todos |
| `firstTodoStarted`     | First todo transitions to `in_progress` | Fires **once per session** when work begins |
| `todoCountAtLeast`     | List has `condition.count` or more items | See options below |

**`todoCountAtLeast` options:**

```json
{ "type": "todoCountAtLeast", "count": 5 }
```

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
{ "type": "toolName", "tool": "todowrite" }
```

**`toolNameIn` options:**

```json
{ "type": "toolNameIn", "tools": ["todowrite", "bash"] }
```

`condition` is optional — omit it to match every occurrence of the event.

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

Instructions are injected on the **next LLM call** after the triggering event. For events like `todo.updated`, the agent almost always generates at least one more response (final summary, commit message, sign-off), so the instruction arrives at the right moment. Each instruction fires exactly once per trigger.

## Examples

### Remind the agent to keep todos up-to-date when it creates a list

```json
{
  "rules": [
    {
      "id": "todo-list-created",
      "event": "todo.updated",
      "agents": ["engineer"],
      "condition": { "type": "todoListCreated" },
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
      "event": "todo.updated",
      "condition": { "type": "allTodosCompleteOnce" },
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

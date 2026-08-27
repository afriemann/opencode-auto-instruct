# opencode-auto-instruct

opencode plugin that injects configurable instructions into agent sessions when events occur. Instructions are hidden from the user (injected into the system prompt) but visible to the agent on its next LLM call after the triggering event.

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
| `instruction` | `string`                  | **yes**  | Text injected into the system prompt |

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

| Condition type      | Applies to              | Matches when |
|---------------------|-------------------------|--------------|
| `allTodosComplete`  | `todo.updated`          | All todos have status `"completed"` |
| `anyTodosComplete`  | `todo.updated`          | At least one todo has status `"completed"` |
| `noTodosInProgress` | `todo.updated`          | No todo has status `"in_progress"` |
| `hasTodos`          | `todo.updated`          | Todo list is non-empty |
| `messageFinished`   | `message.updated`       | Message `info.finish` is truthy |
| `toolName`          | `tool.execute.after`    | `tool` field equals `condition.tool` |

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

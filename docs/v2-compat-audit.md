# opencode V2 Compatibility Audit — `opencode-auto-instruct`

**Date:** 2026-09-15
**Tested against:** `opencode-ai@dev` (`0.0.0-dev-202609142154`), via the
`opencode2` sandbox command. See the shared
`reality/opencode-v2-sandbox-plugin-compat` memory atom for sandbox setup and
the `opencode-use` repo's `docs/v2-compat-audit.md` for the general
methodology and full V2 background — not repeated here in full.

## What "opencode V2" is

See `opencode-use`'s audit doc for the full explanation. In short: V2 is an
Effect-based rewrite (`packages/core`) merged incrementally into the same
`opencode-ai` package, tracked via prerelease dist-tags (`dev` used here).
`opencode debug v2` confirms V2 is live today only for the catalog domain
(providers/models) — the V1 plugin runtime (events, tools, client SDK) is
still fully active in parallel.

## Extension points used by this plugin (`src/index.js`)

| Extension point | Purpose |
|---|---|
| `event` hook | Listens to all opencode events (`session.created`, `todo.updated`, etc.), matches configured rules, and sends instructions |
| `client.session.promptAsync` | SDK method used to deliver a matched rule's instruction as a real, visible conversation turn |
| `client.app.log` | SDK method used for the plugin's own logging |

## Empirical test result

**Setup:** scratch project (`/tmp/opencode/v2-sandbox/test-auto-instruct`)
with `opencode.json` pointing `plugin` at this repo's `src/index.js` (this
worktree, unmodified). The plugin reads its rule config from the fixed path
`~/.config/opencode/auto-instruct.json` (no override mechanism in the source)
— since that file is the user's real, live configuration, it was backed up,
temporarily replaced with a single minimal test rule
(`{"id":"v2-audit-test-rule","event":"session.created","instruction":"V2-AUDIT-TEST-INSTRUCTION-FIRED"}`),
tested, and restored immediately afterward (verified byte-identical via
`diff` post-restore).

```
opencode2 run "say hello" --print-logs --log-level DEBUG
```

**Result — both extension points fired with direct positive evidence:**

| Extension point | Result | Evidence |
|---|---|---|
| `event` hook + rule matching | ✅ Pass (direct evidence) | Log: `[opencode-auto-instruct] loaded 1 rule(s)` then `sent instruction for session=... agent=unknown event=session.created rule=v2-audit-test-rule` |
| `client.session.promptAsync` | ✅ Pass (direct evidence) | The model's actual response referenced the injected text verbatim: *"I see some test markers in the input (\"V2-AUDIT-TEST-INSTRUCTION-FIRED\") that appear to be automated/plugin injections..."* — proof the instruction was delivered as a real conversation turn, not just queued without effect |
| `client.app.log` | ✅ Pass (implicit) | Every `[opencode-auto-instruct]` log line above is emitted via this method; its presence in `--print-logs` output confirms it works |

No `opencode-auto-instruct` errors were logged. The only unrelated failure
observed was the already-known `~/.config/opencode/plugins/opencode-openspec.js`
load failure (`command.trim is not a function`) — tracked in that repo's own
audit.

## Cross-reference against the documented V2 plugin API

V2's plugin API (`packages/plugin/src/v2/{effect,promise}/README.md`) documents
only `agent`/`catalog`/`command`/`integration`/`reference`/`skill` `.transform()`
hooks and `aisdk.sdk`/`aisdk.language` runtime hooks. There is no documented
V2 equivalent for a generic `event` hook, nor for the V1 `client` SDK object.
Empirically, both still work today on the V1 plugin runtime, running
alongside V2's (so-far catalog-only) migration.

## Risk rating and recommended action

Risk = likelihood × impact of this extension point breaking on a future V2
migration (not a security severity scale).

| Extension point | Risk | Recommended action |
|---|---|---|
| `event` hook | Medium | This plugin's entire mechanism depends on it. No V2-documented equivalent for a generic event stream exists yet. Re-test on each `dev` bump. |
| `client.session.promptAsync` | Medium | Depends on the V1 `client` SDK shape remaining available to plugins. Watch for a V2 client/SDK surface replacing it. |
| `client.app.log` | Low | Low-impact if it broke (plugin has a `process.stderr.write` fallback already, per `src/index.js`'s `log()` implementation) — not a functional risk even in a worst case. |

**Overall:** No action needed today — both extension points work correctly
against the current `dev` prerelease, with direct evidence (not just
absence-of-error). Re-run this test after refreshing `~/opencode-v2-sandbox`
periodically.

## How to reproduce this test

```bash
cd ~/opencode-v2-sandbox && npm install opencode-ai@dev && node node_modules/opencode-ai/postinstall.mjs
opencode2 --version

mkdir -p /tmp/auto-instruct-v2-test && cd /tmp/auto-instruct-v2-test
cat > opencode.json << 'EOF'
{ "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-auto-instruct/src/index.js"] }
EOF

# CAUTION: this plugin reads ~/.config/opencode/auto-instruct.json with no
# override mechanism. Back up your real config first, and abort rather than
# proceed if the backup fails — a silent backup failure followed by an
# overwrite is how you'd permanently lose your real config:
if [ -f ~/.config/opencode/auto-instruct.json ]; then
  cp ~/.config/opencode/auto-instruct.json /tmp/auto-instruct-config-BACKUP.json \
    || { echo "BACKUP FAILED — aborting, real config untouched"; exit 1; }
  BACKUP_EXISTED=1
else
  echo "No existing config — will remove the test file on cleanup instead of restoring"
  BACKUP_EXISTED=0
fi

cat > ~/.config/opencode/auto-instruct.json << 'EOF'
{ "rules": [{ "id": "v2-audit-test-rule", "event": "session.created",
  "instruction": "V2-AUDIT-TEST-INSTRUCTION-FIRED" }] }
EOF

opencode2 run "say hello" --print-logs --log-level DEBUG 2>&1 | grep -iE "opencode-auto-instruct|failed"

# Restore (or remove, if there was nothing to restore):
if [ "$BACKUP_EXISTED" = "1" ]; then
  cp /tmp/auto-instruct-config-BACKUP.json ~/.config/opencode/auto-instruct.json \
    && diff /tmp/auto-instruct-config-BACKUP.json ~/.config/opencode/auto-instruct.json \
    && echo "restored OK" \
    || echo "RESTORE FAILED — manual fix needed; backup is at /tmp/auto-instruct-config-BACKUP.json"
else
  rm ~/.config/opencode/auto-instruct.json && echo "test config removed OK"
fi
```

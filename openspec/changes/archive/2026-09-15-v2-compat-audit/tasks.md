## 1. Confirm current V1 extension points

- [x] 1.1 Confirm the plugin's hooks/extension points from `src/index.js`
  (`event` hook; `client.app.log`, `client.session.promptAsync` SDK calls) —
  verify by grepping the source.

## 2. Empirically test against opencode2 (opencode-ai@dev)

- [x] 2.1 In a scratch project, add an `opencode.json` pointing `plugin` at
  this repo's `src/index.js` plus a minimal `~/.config/opencode/auto-instruct.json`
  test rule, run `opencode2 run "..." --print-logs --log-level DEBUG`, and
  capture the log — verify by confirming `[opencode-auto-instruct]`-prefixed
  lines appear.
- [x] 2.2 Confirm the `event` hook fires (`event type=... sessionID=...` debug
  line) and that a matching rule successfully sends an instruction via
  `client.session.promptAsync` (visible as a real conversation turn in the
  output) — verify with a log excerpt as evidence.
- [x] 2.3 Record the tested `opencode2`/`opencode-ai` dev build version.

## 3. Write the audit document

- [x] 3.1 Write `docs/v2-compat-audit.md` with the same structure as the
  `opencode-use` audit (overview, extension-point table, empirical results
  with evidence, V2-doc cross-reference, risk rating, reproduction steps) —
  verify the file exists and both extension points are covered.

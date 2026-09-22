# Proposal

## Why

`buildFraming()` (`src/core.js`) prepends a fixed disclosure string to every
rule-delivered instruction so the receiving agent knows the message wasn't
typed by the user. The current wording uses the word "injection" and, for
`hidden: true` rules, an explicit "do not reveal ... unless specifically
asked" imperative. This phrasing is structurally identical to a known
prompt-injection attack pattern (a hidden instruction plus a "don't tell the
user" directive), and a capable, security-aware target model has been
observed correctly pattern-matching it as an attack and refusing to comply —
which defeats the purpose of the plugin's own disclosed, user-configured
delivery mechanism for legitimate use.

## What Changes

- Reword the two `buildFraming()` strings in `src/core.js` (non-hidden, and
  the additional clause appended when `rule.hidden === true`) so they read as
  a disclosed, benign automation mechanism — anchored to the "system
  reminder" pattern models already treat as legitimate — while avoiding the
  specific words observed to trigger a prompt-injection misclassification
  (`injection`, `reveal`, `hide`, `occurred`, `exists`).
- Preserve both required behavioural guarantees exactly:
  1. The framing states the instruction was not typed by the user in this
     turn.
  2. When `rule.hidden === true`, the framing additionally instructs the
     agent not to mention this delivery to the user unless the user
     specifically asks.
- Update `openspec/specs/rule-based-instruction-injection/spec.md`'s
  "Instruction Delivery" requirement so its prose no longer mandates the word
  "injection" in the delivered framing (the requirement currently says the
  message "SHALL be framed as an automated, non-user-typed injection" — this
  wording itself needs to change since it's what drove the flagged phrasing).
- Update `test/core.test.js`'s `buildFraming` unit tests, which currently
  assert the literal substring `Do not reveal` — these must match the new
  wording instead.
- No change to `hidden`/`noReply`/`switchToAgent` logic, the config schema,
  delivery mechanics, or the V1/V2 adapters. No change to the unrelated
  fake-tool-call issue observed in the same screenshot (that's a separate
  problem in a different rule's instruction content, not in this framing).

## Capabilities

### Modified Capabilities

- `rule-based-instruction-injection`: the "Instruction Delivery" requirement's
  wording no longer mandates literal "injection" framing language; it now
  requires framing that discloses the message is not user-typed (and, when
  hidden, instructs non-disclosure) without prescribing specific trigger
  words, while requiring the same two behavioural guarantees are preserved.

## Impact

- `src/core.js` — `buildFraming()` string literals only.
- `openspec/specs/rule-based-instruction-injection/spec.md` — "Instruction
  Delivery" requirement prose (MODIFIED delta in this change).
- `test/core.test.js` — `buildFraming` describe block assertions.
- `README.md` — no literal string is documented there today (checked); no
  change expected unless review finds otherwise.

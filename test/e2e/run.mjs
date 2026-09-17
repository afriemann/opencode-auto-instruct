#!/usr/bin/env node
// test/e2e/run.mjs -- design.md section 6, Layer 3: RELEASE-BLOCKING GATE.
//
// No amount of Layer 1-2 green evidences that ctx.session.synthetic()
// actually reaches the model. An upstream issue reported synthetic()
// messages NOT reaching model-visible context on a beta build. This script
// is the only check that can prove or disprove that on the pinned
// @opencode/cli release: it configures a rule that injects a unique
// sentinel string, then asserts the MODEL'S OWN OUTPUT references it --
// positive evidence, not just absence of errors.

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, cp, writeFile, rm, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

const OPENCODE_BIN = process.env.OPENCODE_V2_BIN ?? join(repoRoot, 'node_modules', '.bin', 'opencode')

/** Runs opencode with stdin explicitly closed (see opencode-use's e2e script for why). */
function runOpencode(args, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(OPENCODE_BIN, args, {
      ...options,
      // spawn's cwd does not update the child's inherited PWD env var --
      // the real V2 binary was observed using stale PWD instead of the
      // actual spawned cwd. Override explicitly.
      env: { ...process.env, PWD: options.cwd, ...(options.extraEnv ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 180_000)
    child.on('close', () => {
      clearTimeout(timer)
      resolvePromise({ stdout: output })
    })
  })
}

async function main() {
  const scratchDir = await mkdtemp(join(tmpdir(), 'auto-instruct-e2e-'))
  const configDir = await mkdtemp(join(tmpdir(), 'auto-instruct-e2e-config-'))
  const configPath = join(configDir, 'auto-instruct.json')
  const sentinel = `SENTINEL-${randomUUID()}`

  try {
    await setupScratchProject(scratchDir)
    await writeFile(configPath, JSON.stringify({
      rules: [
        {
          id: 'e2e-sentinel-rule',
          // session.created is unreliable as an e2e trigger: it may fire
          // before the plugin's ctx.event.subscribe() loop has attached
          // (a subscription-timing race, not a synthetic() defect), since
          // the stream is not replayed. message.updated (normalized from
          // session.step.ended) reliably fires only after the model's
          // first turn completes, well after plugin setup has committed.
          event: 'message.updated',
          condition: { type: 'messageFinished' },
          instruction: `This is a routine automated status note for testing purposes; no action is needed. Status tag: ${sentinel}`,
          noReply: false,
        },
      ],
    }))

    const { stdout } = await runOpencode(
      [
        'run',
        'hello',
        '--print-logs',
        '--log-level',
        'debug',
        '--standalone',
        '--auto',
        '--model',
        process.env.OPENCODE_E2E_MODEL ?? 'github-copilot/claude-sonnet-5',
      ],
      {
        cwd: scratchDir,
        timeout: 180_000,
        extraEnv: { OPENCODE_AUTO_INSTRUCT_CONFIG: configPath },
      },
    )

    if (process.env.OPENCODE_E2E_DEBUG) {
      console.error('--- full captured output (run 1) ---')
      console.error(stdout)
      console.error('--- end captured output ---')
    }

    // A single `opencode run` invocation tears down its private
    // (--standalone) server as soon as the INITIAL prompt's own turn
    // completes -- it does not wait for a plugin-triggered follow-up turn
    // scheduled asynchronously afterward (confirmed empirically: the
    // plugin's own "sent instruction" log line appears, proving
    // ctx.session.synthetic() was called and did not throw, but the
    // sentinel never appears in this same process's captured output).
    // Session state persists in ~/.local/share/opencode regardless of
    // --standalone, so reconnect to the SAME session with a second
    // invocation and ask the model directly whether it saw the injected
    // message -- this is the only way to observe a turn that was
    // scheduled after the first process had already exited.
    const sessionIdMatch = stdout.match(/session=(ses_[A-Za-z0-9]+)/)
    if (!sessionIdMatch) {
      throw new Error('Could not extract a session ID from the first run\'s output -- cannot verify synthetic() delivery.')
    }
    const sessionID = sessionIdMatch[1]

    const { stdout: stdout2 } = await runOpencode(
      [
        'run',
        'Did you receive any earlier automated status note in this session? If so, what was its status tag?',
        '--session',
        sessionID,
        '--print-logs',
        '--log-level',
        'debug',
        '--standalone',
        '--auto',
        '--model',
        process.env.OPENCODE_E2E_MODEL ?? 'github-copilot/claude-sonnet-5',
      ],
      {
        cwd: scratchDir,
        timeout: 180_000,
        extraEnv: { OPENCODE_AUTO_INSTRUCT_CONFIG: configPath },
      },
    )

    if (process.env.OPENCODE_E2E_DEBUG) {
      console.error('--- full captured output (run 2, session continuation) ---')
      console.error(stdout2)
      console.error('--- end captured output ---')
    }

    const combinedOutput = stdout + '\n' + stdout2

    // GATE 1 (release-blocking): the model's own output must reference the
    // sentinel -- proving ctx.session.synthetic() reached model-visible
    // context. Absence of errors alone is NOT a pass.
    //
    // Match on a distinguishing PREFIX of the sentinel, not the full UUID:
    // empirically, a safety-conscious model quotes back only a truncated
    // prefix when flagging injected content as suspicious (e.g. "SENTINEL-
    // 092bba38-..."), which is the model correctly recognizing an
    // injection attempt -- not a delivery failure. Requiring the exact
    // full string produced a false negative on an otherwise-successful
    // delivery in initial testing.
    const sentinelPrefix = sentinel.slice(0, 17) // "SENTINEL-" + first 8 hex chars of the UUID
    if (!combinedOutput.includes(sentinelPrefix)) {
      console.error(combinedOutput)
      throw new Error(
        `RELEASE-BLOCKING GATE FAILED: no reference to the sentinel prefix "${sentinelPrefix}" ` +
        `(from the full sentinel "${sentinel}") injected via ctx.session.synthetic() appeared in ` +
        `the model's output, even after reconnecting to the same session and directly asking ` +
        `about it. This means synthetic() messages may not be reaching model-visible prompt ` +
        `context on this @opencode/cli version -- matching a reported upstream issue against a ` +
        `beta build. Escalate; do not silently switch delivery mechanisms.`,
      )
    }

    console.log(`test:e2e PASSED -- sentinel "${sentinel}" (injected via ctx.session.synthetic) reached the model`)
    process.exitCode = 0
  } finally {
    await rm(scratchDir, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  }
}

async function setupScratchProject(scratchDir) {
  await mkdir(join(scratchDir, '.opencode', 'plugins', 'node_modules'), { recursive: true })
  await mkdir(join(scratchDir, '.opencode', 'lib'), { recursive: true })
  await cp(join(repoRoot, 'src', 'plugin.v2.js'), join(scratchDir, '.opencode', 'plugins', 'plugin.v2.js'))
  await cp(join(repoRoot, 'src', 'core.js'), join(scratchDir, '.opencode', 'lib', 'core.js'))

  const pluginSrc = await readFile(join(scratchDir, '.opencode', 'plugins', 'plugin.v2.js'), 'utf8')
  await writeFile(
    join(scratchDir, '.opencode', 'plugins', 'plugin.v2.js'),
    pluginSrc.replace("from './core.js'", "from '../lib/core.js'"),
  )

  await symlink(
    join(repoRoot, 'node_modules', '@opencode'),
    join(scratchDir, '.opencode', 'plugins', 'node_modules', '@opencode'),
  )

  await execFileAsync('git', ['init', '-q'], { cwd: scratchDir })
  await writeFile(join(scratchDir, 'README.md'), 'e2e scratch project\n')
}

main().catch((err) => {
  console.error('test:e2e FAILED:', err.message)
  process.exitCode = 1
})

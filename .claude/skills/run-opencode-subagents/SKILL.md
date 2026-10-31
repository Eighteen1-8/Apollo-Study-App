---
name: run-opencode-subagents
description: Deploy, run, or launch local opencode subagents on this machine (max 2 in parallel in text mode, 1 in vision mode), backed by the local Qwen3.8-27B server at 127.0.0.1:8080. Use when asked to delegate, offload, fan out, or parallelize coding tasks to opencode / local Qwen workers, to have a local model look at images, to check the local model, or to see subagent status and results.
---

# Local opencode subagents (Qwen3.8-27B @ 127.0.0.1:8080)

Each subagent is a headless `opencode run` using the `worker` agent. You never call
`opencode` directly: use `driver.mjs`. It asks the server which mode it was started in
and picks the model and a **machine-wide parallel cap** to match:

| Server mode | `max_model_len` | Model the driver uses | Max parallel |
|---|---|---|---|
| text (C2, no vision) | 131072 | `ninfer/qwen3.8-27b` | 2 |
| vision (C1) | 100000 | `ninfer/qwen3.8-27b-vision` | 1 |

The cap is enforced with lock files, so separate or backgrounded driver calls share it.
Extra jobs wait for a free slot. Override with `SUBAGENT_MODEL` / `SUBAGENT_MAX_PARALLEL`.

Paths are relative to the project root. Driver: `.claude/skills/run-opencode-subagents/driver.mjs`.

## Prerequisites (already set up on this machine)

- `opencode` v2.2.5 (npm global), Node 24.
- Qwen server reachable at `http://127.0.0.1:8080/v1`, model id `qwen3.8-27b`.
- `~/.config/opencode/opencode.json` (backup of the original: `opencode.json.bak-20261031`, which used the provider id `lmstudio`) defines:
  - custom provider `ninfer` (the server's engine, via `@ai-sdk/openai-compatible`) with `settings.baseURL` = `http://127.0.0.1:8080/v1` and two entries that both
    send the server model id `qwen3.8-27b`: `qwen3.8-27b` (text input, context 131072) and
    `qwen3.8-27b-vision` (`modelID: qwen3.8-27b`, text+image input, context 100000). Both have tools on,
    `reasoningField: reasoning_content`, `limit.output` 32768, variants `low|medium|high` (reasoning_effort).
  - default `model: ninfer/qwen3.8-27b`.
  - agent `worker`: allows all tools inside its directory; **denies** `external_directory`,
    `question`, nested `subagent`, `.env` reads, and `browser`; 60 steps max.

## Run (agent path)

Always check first. It prints the detected mode. Exit code 1 means the server is down or the context limit is mismatched:

```bash
node .claude/skills/run-opencode-subagents/driver.mjs check
```

One task (blocks until done; prints a JSON summary with `final` = the subagent's last answer):

```bash
node .claude/skills/run-opencode-subagents/driver.mjs run --dir path/to/workdir --name fizz --variant low "Write fizzbuzz.py for 1..15, run it, report the last 3 lines."
```

- `--dir` is the subagent's sandbox: it can only edit files under it. Give each parallel job its own dir
  (or disjoint files) so they don't clobber each other.
- `--variant low|medium|high` sets reasoning effort (omit for the server default). `--timeout <s>` (default 1800).
- `--file <path>` (repeatable; `"files": [...]` in batch) attaches files. Images only work in vision mode
  (the driver warns otherwise). Verified: `run --dir v1 --file card.png "What text is in the image?"`.
- `--prompt-file task.md` is for long briefs. Prompts over 8000 chars are attached as a file automatically.

Fan out (runs up to the cap at a time; `dir`/`promptFile` resolve relative to the JSON file):

```bash
mkdir -p a b   # each job's dir must already exist
cat > jobs.json <<'EOF'
[
  {"name": "fizz", "dir": "a", "variant": "low", "prompt": "Write fizzbuzz.py printing FizzBuzz for 1..15, run it with python, and report the last 3 lines of output."},
  {"name": "wc",   "dir": "b", "variant": "low", "prompt": "Create words.txt with 'the quick brown fox jumps over the lazy dog', write and run count.py that prints its word count. Report the count."}
]
EOF
node .claude/skills/run-opencode-subagents/driver.mjs batch jobs.json > summary.json
```

Progress (`[name] tool write -> completed` etc.) goes to stderr and the summary JSON to stdout. Exit 0 only if every job succeeded.
For long jobs, run the command with Bash `run_in_background` and keep working. The cap still holds.

Inspect:

```bash
node .claude/skills/run-opencode-subagents/driver.mjs status
node .claude/skills/run-opencode-subagents/driver.mjs show fizz
```

Every run writes `~/.local/state/opencode-subagents/runs/<timestamp>-<name>/` containing `prompt.md`,
`events.jsonl` (raw opencode JSON events), `stderr.log`, `result.json` and `final.md`.
**Verify a subagent's work from the files it changed, not from its own summary.** Qwen sometimes
misreports what it did. In one test it wrote a file and then claimed it hadn't.

## Run (human path)

`opencode` in a terminal opens the TUI on the same local model. Use `opencode run --agent worker "..."` for a one-off.

## Gotchas

- **Mode is inferred from `max_model_len` alone** (≤100000 means vision/C1). `/v1/models` exposes nothing else:
  no concurrency and no vision flag. If the server is started with other settings, update `MODES` /
  `VISION_MAX_LEN` in the driver and `limit.context` in the config. Mode is read once at driver start, so restarting
  the server mid-batch keeps the old cap.
- **Context limit vs. server.** opencode compacts based on `limit.context` in the config, so if that is higher than
  the server's `max_model_len`, long runs fail instead of compacting. `check` warns and exits 1 on a mismatch.
- **`$PWD` beats cwd.** opencode takes its project dir from the `PWD` env var (Git Bash exports it), not the
  spawned process's cwd. Without the driver's `PWD` override, every job wrote into the *driver's* cwd and the
  `external_directory` sandbox was relative to the wrong folder. Any other launcher needs the same fix.
- **Don't use `opencode run --auto`.** The Claude Code auto-mode classifier blocks it (it approves everything).
  The `worker` agent's explicit rules make it unnecessary, because nothing in `worker` is "ask".
- **v2 config schema**: the key is `providers` (plural). The base URL goes in `settings.baseURL`, not the
  v1 `options.baseURL`, and agents live under `agents` with ordered `permissions` rules
  (`{action, resource, effect}`). v2 tool action names are `shell`, `edit`, `read`, `external_directory`, `subagent`.
  Check the effective rules with `opencode debug agents`.
- Use a custom provider id (`ninfer`), not a built-in one like `lmstudio`. A built-in id merges in its catalog
  (`lmstudio/openai/gpt-oss-20b`, ...), and those models would all point at :8080 and fail.
- On Windows the driver spawns the real `opencode.exe` (under `%APPDATA%\npm\node_modules\@opencode\cli\bin\`)
  rather than the `.cmd` shim, so prompts need no shell quoting. Override with `OPENCODE_BIN`.
- Each job uses `--standalone` (a private opencode server). Startup overhead is about 2 seconds. Small tasks take 3 to 12 seconds total.

## Troubleshooting

- `server: UNREACHABLE` → the Qwen server isn't running. Test it with `curl -s http://127.0.0.1:8080/v1/models`.
- A job stuck at `waiting for a free slot` with nothing running → `status` shows the holder pid. Locks from dead
  pids are reclaimed automatically. To clear by hand, delete `~/.local/state/opencode-subagents/slots/slot-*.lock`.
- `Permission denied: external_directory` in a job's events → the subagent tried to touch files outside `--dir`.
  This is working as intended. Widen `--dir` if it really needs access.

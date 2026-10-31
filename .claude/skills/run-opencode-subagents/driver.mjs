#!/usr/bin/env node
// Driver for local opencode subagents backed by the Qwen server at 127.0.0.1:8080.
// The server runs in one of two modes, told apart only by max_model_len:
//   text   131k, 2 concurrent sequences -> ninfer/qwen3.8-27b,        2 slots
//   vision 100k, 1 concurrent sequence  -> ninfer/qwen3.8-27b-vision, 1 slot
// The slot cap is machine-wide, enforced with lock files so separate driver
// invocations (e.g. two background Bash calls) share it.
//
//   node driver.mjs check
//   node driver.mjs run   --dir <path> [--name n] [--variant low|medium|high] [--timeout s] "<prompt>"
//   node driver.mjs run   --dir <path> --prompt-file task.md
//   node driver.mjs run   --dir <path> --file diagram.png "Describe this"   # vision mode only
//   node driver.mjs batch jobs.json          # [{name, dir, prompt|promptFile, variant?, timeout?}]
//   node driver.mjs status
//   node driver.mjs show  <run-dir|name>     # print a finished run's result.json + final text

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_URL = process.env.QWEN_BASE_URL || "http://127.0.0.1:8080/v1";
const SERVER_MODEL = "qwen3.8-27b";
const VISION_MAX_LEN = 100000; // server reports this when started in vision mode
const MODES = {
  text:   { model: "ninfer/qwen3.8-27b",        slots: 2 },
  vision: { model: "ninfer/qwen3.8-27b-vision", slots: 1 },
};
const CONFIG_FILE = path.join(os.homedir(), ".config", "opencode", "opencode.json");
let MODEL = process.env.SUBAGENT_MODEL;  // set by detectMode()
let MAX_SLOTS = Number(process.env.SUBAGENT_MAX_PARALLEL) || 0;
let SERVER = null;
const AGENT = process.env.SUBAGENT_AGENT || "worker";
const STATE = process.env.SUBAGENT_STATE || path.join(os.homedir(), ".local", "state", "opencode-subagents");
const SLOTS = path.join(STATE, "slots");
const RUNS = path.join(STATE, "runs");
const DEFAULT_TIMEOUT_S = 1800;
const MAX_ARG_PROMPT = 8000; // longer prompts go through an attached file (Windows cmdline limit)

function opencodeBin() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  if (process.platform === "win32") {
    // The npm shim is a .cmd; spawn the real exe so prompts need no shell quoting.
    const exe = path.join(process.env.APPDATA || "", "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return "opencode";
}

async function detectMode() {
  const r = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(5000) });
  const m = (await r.json()).data?.find((x) => x.id === SERVER_MODEL);
  if (!m) throw new Error(`server at ${BASE_URL} does not serve ${SERVER_MODEL}`);
  const mode = m.max_model_len <= VISION_MAX_LEN ? "vision" : "text";
  SERVER = { mode, maxLen: m.max_model_len };
  MODEL ||= MODES[mode].model;
  MAX_SLOTS ||= MODES[mode].slots;
  return SERVER;
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") (opts.file ||= []).push(argv[++i]);
    else if (a.startsWith("--")) opts[a.slice(2)] = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// ---- global slot locks ------------------------------------------------------

function tryAcquire(name) {
  fs.mkdirSync(SLOTS, { recursive: true });
  for (let i = 0; i < MAX_SLOTS; i++) {
    const f = path.join(SLOTS, `slot-${i}.lock`);
    try {
      fs.writeFileSync(f, JSON.stringify({ pid: process.pid, name, since: new Date().toISOString() }), { flag: "wx" });
      return f;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const held = JSON.parse(fs.readFileSync(f, "utf8"));
        if (!alive(held.pid)) fs.rmSync(f, { force: true }); // stale lock from a killed driver
      } catch { /* racing with another acquirer; retry next poll */ }
    }
  }
  return null;
}

async function acquire(name) {
  let waited = false;
  for (;;) {
    const f = tryAcquire(name);
    if (f) return f;
    if (!waited) { log(`[${name}] waiting for a free slot (max ${MAX_SLOTS})...`); waited = true; }
    await sleep(2000);
  }
}

function slotStatus() {
  fs.mkdirSync(SLOTS, { recursive: true });
  // show both lock files: a text-mode job can still hold slot 1 after the server switched to vision mode
  return [...Array(Math.max(MAX_SLOTS, MODES.text.slots)).keys()].map((i) => {
    const f = path.join(SLOTS, `slot-${i}.lock`);
    if (!fs.existsSync(f)) return { slot: i, free: true };
    const held = JSON.parse(fs.readFileSync(f, "utf8"));
    return { slot: i, free: false, stale: !alive(held.pid), ...held };
  });
}

// ---- running one subagent ----------------------------------------------------

function log(...a) { console.error(...a); }

async function runJob(job) {
  const name = (job.name || "job").replace(/[^\w.-]+/g, "_");
  const dir = path.resolve(job.dir || process.cwd());
  if (!fs.existsSync(dir)) throw new Error(`--dir does not exist: ${dir}`);
  let prompt = job.prompt ?? (job.promptFile ? fs.readFileSync(job.promptFile, "utf8") : null);
  if (!prompt) throw new Error(`job ${name}: no prompt / promptFile`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(RUNS, `${stamp}-${name}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "prompt.md"), prompt);

  const model = job.variant ? `${MODEL}#${job.variant}` : MODEL;
  const args = ["run", "--standalone", "--format", "json", "--agent", AGENT, "-m", model, "--title", `subagent:${name}`];
  for (const f of job.files || []) {
    if (!fs.existsSync(f)) throw new Error(`job ${name}: --file not found: ${f}`);
    if (/.(png|jpe?g|gif|webp|bmp)$/i.test(f) && SERVER?.mode !== "vision")
      log(`[${name}] WARN: attaching image ${path.basename(f)} but the server is in ${SERVER?.mode} mode (no vision)`);
    args.push("--file", path.resolve(f));
  }
  if (prompt.length > MAX_ARG_PROMPT) {
    args.push("--file", path.join(runDir, "prompt.md"));
    prompt = "Your full task is in the attached file prompt.md. Read it and carry it out.";
  }
  args.push(prompt);

  const lock = await acquire(name);
  const t0 = Date.now();
  log(`[${name}] started in ${dir} (logs: ${runDir})`);
  const result = { name, dir, runDir, model, agent: AGENT, sessionID: null, exitCode: null, timedOut: false,
                   text: "", tools: [], errors: [], tokens: { input: 0, output: 0, reasoning: 0 }, durationMs: 0 };
  try {
    const events = fs.createWriteStream(path.join(runDir, "events.jsonl"));
    const stderr = fs.createWriteStream(path.join(runDir, "stderr.log"));
    // opencode takes its project dir from $PWD when set (Git Bash exports it), not the real cwd: override both
    const child = spawn(opencodeBin(), args, { cwd: dir, env: { ...process.env, PWD: dir }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timeoutS = Number(job.timeout || DEFAULT_TIMEOUT_S);
    const timer = setTimeout(() => { result.timedOut = true; child.kill(); }, timeoutS * 1000);
    let buf = "";
    child.stdout.on("data", (d) => {
      events.write(d);
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) { handleEvent(buf.slice(0, nl), result, name); buf = buf.slice(nl + 1); }
    });
    child.stderr.pipe(stderr);
    result.exitCode = await new Promise((res) => { child.on("close", res); child.on("error", (e) => { result.errors.push(String(e)); res(-1); }); });
    if (buf.trim()) handleEvent(buf, result, name);
    clearTimeout(timer);
    events.end(); stderr.end();
  } finally {
    fs.rmSync(lock, { force: true });
  }
  result.durationMs = Date.now() - t0;
  result.ok = result.exitCode === 0 && !result.timedOut && result.errors.length === 0;
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(runDir, "final.md"), result.text);
  log(`[${name}] ${result.ok ? "done" : "FAILED"} in ${(result.durationMs / 1000).toFixed(1)}s, ` +
      `${result.tools.length} tool calls, exit ${result.exitCode}${result.timedOut ? " (timeout)" : ""}`);
  return result;
}

function handleEvent(line, result, name) {
  if (!line.trim()) return;
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (e.sessionID) result.sessionID = e.sessionID;
  const p = e.part || {};
  if (e.type === "text" && p.text) result.text = p.text; // last text part = the agent's final answer
  if (e.type === "tool_use") {
    result.tools.push({ tool: p.tool, status: p.state?.status });
    log(`[${name}] tool ${p.tool} -> ${p.state?.status}`);
  }
  if (e.type === "step_finish" && p.tokens) {
    for (const k of ["input", "output", "reasoning"]) result.tokens[k] += p.tokens[k] || 0;
  }
  if (e.type === "error" || e.error) result.errors.push(JSON.stringify(e.error || e).slice(0, 500));
}

// ---- commands ------------------------------------------------------------------

async function check() {
  let ok = true;
  try {
    await detectMode();
    console.log(`server: ${BASE_URL} model=${SERVER_MODEL} max_model_len=${SERVER.maxLen} -> ${SERVER.mode} mode`);
    // opencode compacts based on its own limit.context; if that exceeds the server's, long runs 400 instead of compacting
    const [prov, id] = MODEL.split("/");
    const cfgCtx = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).providers?.[prov]?.models?.[id]?.limit?.context;
    console.log(`config: ${CONFIG_FILE} ${id} limit.context=${cfgCtx ?? "unset"}`);
    if (cfgCtx && cfgCtx > SERVER.maxLen) { ok = false; console.log(`WARN: limit.context ${cfgCtx} > server max_model_len ${SERVER.maxLen}; lower it in the config`); }
  } catch (e) { ok = false; MAX_SLOTS ||= 1; console.log(`server: UNREACHABLE at ${BASE_URL} (${e.message})`); }
  const bin = opencodeBin();
  console.log(`opencode: ${bin}`);
  console.log(`subagent: agent=${AGENT} model=${MODEL} max_parallel=${MAX_SLOTS} state=${STATE}`);
  for (const s of slotStatus()) console.log(`slot ${s.slot}: ${s.free ? "free" : `${s.name} pid=${s.pid}${s.stale ? " (stale)" : ""}`}`);
  process.exit(ok ? 0 : 1);
}

function status() {
  for (const s of slotStatus()) console.log(`slot ${s.slot}: ${s.free ? "free" : `busy  ${s.name} pid=${s.pid} since ${s.since}${s.stale ? " (stale)" : ""}`}`);
  if (!fs.existsSync(RUNS)) return;
  const recent = fs.readdirSync(RUNS).sort().slice(-10);
  for (const d of recent) {
    const rf = path.join(RUNS, d, "result.json");
    if (!fs.existsSync(rf)) { console.log(`run  ${d}  (running or killed)`); continue; }
    const r = JSON.parse(fs.readFileSync(rf, "utf8"));
    console.log(`run  ${d}  ${r.ok ? "ok" : "FAILED"}  ${(r.durationMs / 1000).toFixed(0)}s  tools=${r.tools.length}`);
  }
}

function show(which) {
  const d = fs.existsSync(which) ? which
    : path.join(RUNS, fs.readdirSync(RUNS).filter((x) => x.endsWith(`-${which}`) || x === which).sort().pop() || "");
  const rf = path.join(d, "result.json");
  if (!fs.existsSync(rf)) { console.error(`no finished run matching ${which}`); process.exit(1); }
  const r = JSON.parse(fs.readFileSync(rf, "utf8"));
  console.log(JSON.stringify({ ...r, text: undefined }, null, 2));
  console.log("\n--- final answer ---\n" + r.text);
}

function summary(results) {
  console.log(JSON.stringify(results.map(({ name, ok, exitCode, timedOut, durationMs, runDir, sessionID, tools, text }) =>
    ({ name, ok, exitCode, timedOut, seconds: Math.round(durationMs / 1000), toolCalls: tools.length, sessionID, runDir, final: text })), null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
if (cmd === "check") await check();
else if (cmd === "status") { await detectMode().catch(() => {}); status(); }
else if (cmd === "show") show(opts._[0]);
else if (cmd === "run") {
  await detectMode();
  log(`server in ${SERVER.mode} mode (max_model_len ${SERVER.maxLen}): ${MODEL}, max ${MAX_SLOTS} parallel`);
  const r = await runJob({ files: opts.file, name: opts.name, dir: opts.dir, variant: opts.variant, timeout: opts.timeout,
                           prompt: opts._.join(" ") || undefined, promptFile: opts["prompt-file"] });
  summary([r]);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === "batch") {
  await detectMode();
  log(`server in ${SERVER.mode} mode (max_model_len ${SERVER.maxLen}): ${MODEL}, max ${MAX_SLOTS} parallel`);
  const file = opts._[0];
  const base = path.dirname(path.resolve(file));
  const jobs = JSON.parse(fs.readFileSync(file, "utf8")).map((j) => ({
    ...j, dir: j.dir && path.resolve(base, j.dir), promptFile: j.promptFile && path.resolve(base, j.promptFile),
    files: j.files?.map((f) => path.resolve(base, f)) }));
  const queue = [...jobs.entries()];
  const results = [];
  await Promise.all([...Array(Math.min(MAX_SLOTS, jobs.length))].map(async () => {
    for (let item; (item = queue.shift());) {
      const [i, job] = item;
      try { results[i] = await runJob(job); }
      catch (e) { results[i] = { name: job.name, ok: false, errors: [String(e)], tools: [], durationMs: 0, text: String(e) }; }
    }
  }));
  summary(results);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
} else {
  console.error("usage: driver.mjs check | status | show <name|runDir> | run --dir D [--name N] [--variant V] [--timeout S] [--file F]... \"prompt\" | batch jobs.json");
  process.exit(2);
}

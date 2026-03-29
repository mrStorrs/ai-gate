#!/usr/bin/env node
/**
 * ai-gate — PreToolUse hook for Claude Code
 *
 * Gate mode (stored in .mode, defaults to "on"):
 *   yolo — approve everything unconditionally
 *   ask  — approve everything except ask-list items (skip Haiku)
 *   on   — full pipeline (default)
 *
 * Decision flow in "on" mode:
 *   1. ask list match   → deny with message (requires manual review)
 *   2. allow list match → approve instantly (no API call)
 *   3. compound Bash    → skip allow list, send to AI (hidden second commands)
 *   4. unknown          → ask Claude Haiku for a safety verdict
 *                           safe    → approve + auto-learn the pattern
 *                           unsafe  → deny with AI's reason
 *                           error   → deny (fail safe)
 *
 * Config:  ./config.json   — allow / ask rules
 * Mode:    ./.mode         — current gate mode (yolo | ask | on)
 * API key: ./.api-key      — your Anthropic API key (one line)
 * Logs:    ./gate.log      — every decision recorded here
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const https = require("https");

const GATE_DIR    = path.dirname(__filename);
const CONFIG_PATH = path.join(GATE_DIR, "config.json");
const LOG_PATH    = path.join(GATE_DIR, "gate.log");
const MODE_PATH   = path.join(GATE_DIR, ".mode");

// ── gate mode ─────────────────────────────────────────────────────────────────
// "on"   — full pipeline: ask list → allow list → Haiku AI check (default)
// "ask"  — skip Haiku, auto-approve everything except ask-list items
// "yolo" — approve everything unconditionally

function loadMode() {
  try {
    const mode = fs.readFileSync(MODE_PATH, "utf-8").trim().toLowerCase();
    if (["yolo", "ask", "on"].includes(mode)) return mode;
  } catch { /* missing = default */ }
  return "on";
}

// ── config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return { ask: [], allow: [] };
  }
}

// ── matching ──────────────────────────────────────────────────────────────────

function getSubjectText(toolName, toolInput) {
  switch (toolName) {
    case "Bash":  return toolInput.command   || "";
    case "Write":
    case "Edit":  return toolInput.file_path || "";
    case "Read":  return toolInput.file_path || "";
    default:      return JSON.stringify(toolInput);
  }
}

function matchesRules(rules, toolName, toolInput) {
  const text = getSubjectText(toolName, toolInput);
  for (const rule of rules) {
    if (rule.tool && rule.tool !== toolName) continue;
    if (rule.pattern) {
      try {
        if (!new RegExp(rule.pattern, "i").test(text)) continue;
      } catch {
        continue; // skip malformed regex entries
      }
    }
    return true;
  }
  return false;
}

// Compound operators can hide dangerous second commands after a safe-looking
// first token (e.g. "git status && rm -rf /"). Skip the allow list for these
// and let the AI evaluate the full command instead.
// Pipes (|) are excluded — the ask list already catches dangerous pipe targets.
const COMPOUND_RE = /&&|\|\||;|\$\(|`/;

function isCompoundBash(toolName, toolInput) {
  return toolName === "Bash" && COMPOUND_RE.test(toolInput.command || "");
}

// ── logging ───────────────────────────────────────────────────────────────────

function log(decision, reason, toolName, toolInput) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify({
      ts: new Date().toISOString(),
      decision,
      reason,
      tool: toolName,
      subject: getSubjectText(toolName, toolInput),
    }) + "\n");
  } catch { /* logging is best-effort */ }
}

// ── output ────────────────────────────────────────────────────────────────────

function decide(decision, reason, toolName, toolInput) {
  log(decision, reason, toolName, toolInput);
  // Valid permissionDecision values: "allow" | "ask" | "deny"
  // We only use "allow" (auto-approve) and "ask" (prompt user). Never hard-deny.
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
    },
  };
  if (reason) out.hookSpecificOutput.permissionDecisionReason = reason;
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

// ── auto-learning ─────────────────────────────────────────────────────────────

// When the AI approves an unknown command, derive a general pattern and append
// it to the allow list so future similar calls skip the API entirely.
function learnApproval(toolName, toolInput) {
  try {
    const config  = loadConfig();
    const allow   = config.allow || [];
    const subject = getSubjectText(toolName, toolInput);

    // Skip if an existing rule already covers this call
    const alreadyCovered = allow.some(rule => {
      if (rule.tool && rule.tool !== toolName) return false;
      if (!rule.pattern) return true;
      try { return new RegExp(rule.pattern, "i").test(subject); } catch { return false; }
    });
    if (alreadyCovered) return;

    let newRule = null;

    if (toolName === "Bash") {
      const command = (toolInput.command || "").trim();
      if (COMPOUND_RE.test(command)) return; // skip compound commands
      const firstToken = command.split(/\s+/)[0];
      if (!firstToken) return;
      const escaped = firstToken.replace(/[.^$*+?{}[\]\\|()]/g, "\\$&");
      newRule = { _note: `AI auto-learned: ${firstToken}`, tool: "Bash", pattern: `^${escaped}(\\s|$)` };

    } else if (toolName === "Edit" || toolName === "Write") {
      const filePath = toolInput.file_path || "";
      const dir = filePath.replace(/[/\\][^/\\]+$/, ""); // strip filename
      if (!dir) return;
      const escaped = dir.replace(/[.^$*+?{}[\]\\|()]/g, "\\$&");
      newRule = { _note: `AI auto-learned: files in ${dir}`, tool: toolName, pattern: `^${escaped}[/\\\\]` };
    }

    if (!newRule) return;
    config.allow.push(newRule);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch { /* learning is best-effort, never crash the gate */ }
}

// ── API key ───────────────────────────────────────────────────────────────────

function loadApiKey() {
  // Preferred: .api-key file — keeps the key out of Claude Code's own env so
  // the main session continues to use your subscription / OAuth.
  try {
    const key = fs.readFileSync(path.join(GATE_DIR, ".api-key"), "utf-8").trim();
    if (key && !key.startsWith("PASTE_YOUR")) return key;
  } catch { /* file missing — fall through */ }

  // Fallback: ANTHROPIC_API_KEY env var (e.g. in CI or devcontainers).
  // WARNING: if this env var is set in ~/.claude/settings.json it will also
  // route Claude Code's own requests through the API key, bypassing your
  // subscription. Set it at the OS level instead.
  return process.env.ANTHROPIC_API_KEY || null;
}

// ── Claude Haiku safety check ─────────────────────────────────────────────────

function askClaude(toolName, toolInput) {
  return new Promise((resolve) => {
    const apiKey = loadApiKey();
    if (!apiKey) {
      resolve({ safe: null, reason: "No API key found — create a .api-key file (see README)" });
      return;
    }

    const prompt = `You are a security gate for Claude Code, an AI coding assistant running on a developer's machine.
Decide if this tool call is safe to auto-approve without prompting the user.

Tool: ${toolName}
Input: ${JSON.stringify(toolInput, null, 2)}

Respond ONLY with valid JSON — no text outside it:
{"safe": true, "reason": "one sentence"}
or
{"safe": false, "reason": "one sentence"}

Mark UNSAFE: rm -rf on home/root/system dirs, curl/wget piped to a shell, DROP DATABASE/TABLE, writes to OS system directories, reading credentials or secrets files, privilege escalation.
Mark SAFE: reading source files, writing code in project dirs, git operations, npm/yarn/pnpm/npx, running tests and builds, mkdir, ls, echo, standard developer tooling.`;

    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text   = (parsed.content?.[0]?.text || "").trim();
          const match  = text.match(/\{[\s\S]*?\}/);
          if (match) {
            const result = JSON.parse(match[0]);
            resolve({ safe: result.safe === true, reason: result.reason || "" });
          } else {
            resolve({ safe: null, reason: "Could not parse AI response" });
          }
        } catch {
          resolve({ safe: null, reason: "API response parse error" });
        }
      });
    });

    req.on("error", () => resolve({ safe: null, reason: "Network error reaching Claude API" }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ safe: null, reason: "Claude API timeout" }); });
    req.write(body);
    req.end();
  });
}

// ── main ──────────────────────────────────────────────────────────────────────

let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", chunk => (raw += chunk));
process.stdin.on("end", async () => {
  try {
    await run();
  } catch (err) {
    // Unhandled error — fail safe, ask the user
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "ai-gate internal error: " + err.message,
      },
    }) + "\n");
    process.exit(0);
  }
});

async function run() {
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // unparseable — pass through to normal permission system
  }

  const toolName  = input.tool_name  || "";
  const toolInput = input.tool_input || {};
  const config    = loadConfig();
  const mode      = loadMode();

  // ── yolo mode: approve everything unconditionally ─────────────────────────
  if (mode === "yolo") {
    decide("allow", "yolo mode — all checks bypassed", toolName, toolInput);
    return;
  }

  // 1. Ask list — deny immediately, require manual review.
  //    For compound Bash commands also scan with ^ stripped so that
  //    "cd /tmp && git push" is caught even though the string doesn't start with "git".
  const askRules = config.ask || [];
  const matchesAsk = matchesRules(askRules, toolName, toolInput) ||
    (isCompoundBash(toolName, toolInput) && matchesRules(
      askRules.map(r => r.pattern ? { ...r, pattern: r.pattern.replace(/^\^/, "") } : r),
      toolName, toolInput
    ));
  if (matchesAsk) {
    decide("ask", "Blocked by ai-gate ask list — review this command before approving", toolName, toolInput);
    return;
  }

  // ── ask mode: everything not on the ask list is auto-approved ─────────────
  if (mode === "ask") {
    decide("allow", "ask mode — auto-approved (not on ask list)", toolName, toolInput);
    return;
  }

  // 2. Allow list — approve instantly (skip AI for known-safe patterns)
  //    Exception: compound Bash commands skip the allow list because the
  //    ^anchor patterns only validate the first token.
  if (!isCompoundBash(toolName, toolInput) && matchesRules(config.allow || [], toolName, toolInput)) {
    decide("allow", null, toolName, toolInput);
    return;
  }

  // 3. Unknown — consult Claude Haiku
  const { safe, reason } = await askClaude(toolName, toolInput);

  if (safe === true) {
    learnApproval(toolName, toolInput);
    decide("allow", `AI approved: ${reason}`, toolName, toolInput);
  } else if (safe === false) {
    decide("ask", `AI flagged — review before approving: ${reason}`, toolName, toolInput);
  } else {
    // API unavailable or errored — fail safe, ask the user
    decide("ask", `AI gate fallback (${reason})`, toolName, toolInput);
  }
}

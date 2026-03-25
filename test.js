#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");
const path = require("path");

const GATE = path.join(__dirname, "gate.js");

function run(toolName, input) {
  const stdin = JSON.stringify({ tool_name: toolName, tool_input: input });
  const out = execSync(`node "${GATE}"`, { input: stdin, encoding: "utf-8" });
  return JSON.parse(out).hookSpecificOutput;
}

const tests = [
  // allow list
  ["allow", "Read",  { file_path: "src/index.ts" }],
  ["allow", "Bash",  { command: "git status" }],
  ["allow", "Bash",  { command: "npm install" }],
  ["allow", "Bash",  { command: "ls -la" }],
  // ask list — simple (should prompt user, not hard-deny)
  ["ask",   "Bash",  { command: "rm -rf node_modules" }],
  ["ask",   "Bash",  { command: "git push origin main" }],
  ["ask",   "Bash",  { command: "git reset --hard HEAD~1" }],
  ["ask",   "Bash",  { command: "git rebase main" }],
  // ask list — compound (the ^ strip test)
  ["ask",   "Bash",  { command: "cd /tmp && git push" }],
  ["ask",   "Bash",  { command: "git fetch && git reset --hard origin/main" }],
];

let pass = 0, fail = 0;
for (const [expected, tool, input] of tests) {
  const result = run(tool, input);
  const got    = result.permissionDecision;
  const ok     = got === expected;
  const label  = (input.command || input.file_path || "").slice(0, 55).padEnd(56);
  console.log((ok ? "✓" : "✗"), tool.padEnd(5), label, "→", got, ok ? "" : "  EXPECTED: " + expected);
  ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);

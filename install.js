#!/usr/bin/env node
/**
 * ai-gate installer
 * Adds the PreToolUse hook entry to ~/.claude/settings.json
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const GATE_DIR      = __dirname;
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const KEY_FILE      = path.join(GATE_DIR, ".api-key");

// ── helpers ───────────────────────────────────────────────────────────────────

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2));
}

// ── main ──────────────────────────────────────────────────────────────────────

console.log("ai-gate installer\n");

// 1. Create .api-key placeholder if missing
if (!fs.existsSync(KEY_FILE)) {
  fs.writeFileSync(KEY_FILE, "PASTE_YOUR_ANTHROPIC_API_KEY_HERE\n");
  console.log(`Created ${KEY_FILE}`);
  console.log("  → Open it and replace the placeholder with your sk-ant-... key.\n");
} else {
  console.log(`✓ .api-key already exists\n`);
}

// 2. Register the PreToolUse hook in settings.json
const settings = readSettings();
settings.hooks = settings.hooks || {};
settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];

const hookCmd = `node "${GATE_DIR.replace(/\\/g, "/")}/gate.js"`;
const alreadyInstalled = settings.hooks.PreToolUse.some(entry =>
  entry.hooks?.some(h => h.command === hookCmd)
);

if (alreadyInstalled) {
  console.log("✓ Hook already registered in", SETTINGS_PATH);
} else {
  // Prepend so it runs before any other PreToolUse hooks
  settings.hooks.PreToolUse.unshift({
    matcher: "*",
    hooks: [{ type: "command", command: hookCmd }],
  });
  writeSettings(settings);
  console.log("✓ Hook registered in", SETTINGS_PATH);
}

// 3. Install the /gate slash command
const COMMANDS_SRC  = path.join(GATE_DIR, "commands", "gate.md");
const COMMANDS_DEST = path.join(os.homedir(), ".claude", "commands", "gate.md");

if (fs.existsSync(COMMANDS_SRC)) {
  fs.mkdirSync(path.dirname(COMMANDS_DEST), { recursive: true });

  // Template the .mode path into the command file
  const template = fs.readFileSync(COMMANDS_SRC, "utf-8");
  const modePath = path.join(GATE_DIR, ".mode").replace(/\\/g, "/");
  const rendered = template.replace(
    /the `\.mode` file inside the ai-gate hook directory \(just the mode string, no newline padding\)\. The hook directory is wherever `gate\.js` is installed\./,
    `\`${modePath}\` (just the mode string, no newline padding).`
  );

  fs.writeFileSync(COMMANDS_DEST, rendered);
  console.log("✓ /gate command installed to", COMMANDS_DEST);
} else {
  console.log("⚠ commands/gate.md not found in ai-gate — skipping slash command install");
}

console.log("\nInstallation complete.");
console.log("Restart Claude Code for the hook to take effect.");

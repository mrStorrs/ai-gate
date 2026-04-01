# ai-gate

A [Claude Code](https://claude.ai/code) `PreToolUse` hook that acts as a smart permission gate for every tool call your AI agent makes.

- **Allow list** → auto-approved instantly, no prompt, no API call
- **Ask list** → always blocked with a message (requires your manual review)
- **Everything else** → sent to Claude Haiku for a safety verdict in ~1s
  - Safe → auto-approved, pattern saved to allow list for next time
  - Unsafe → blocked with AI's reason

Your main Claude Code session continues to use your subscription/OAuth. Only the safety-check calls go through the API key.

---

## Gate modes

The gate runs in one of three modes, controlled by a `.mode` file in the gate directory:

| Mode   | Behaviour |
|--------|-----------|
| `on`   | Full pipeline — ask list → allow list → Haiku AI check *(default)* |
| `ask`  | Ask-list items still prompt; everything else is auto-approved (no Haiku call) |
| `yolo` | Approve everything unconditionally — no checks at all |

Switch modes with the `/gate` slash command in Claude Code:

```
/gate yolo   # no checks
/gate ask    # skip AI checks, keep ask list
/gate on     # restore full pipeline
```

Or write the mode name directly to `.mode`:

```bash
echo "ask"  > /path/to/ai-gate/.mode
echo "yolo" > /path/to/ai-gate/.mode
echo "on"   > /path/to/ai-gate/.mode
```

If `.mode` is missing or contains an unrecognised value the gate defaults to `on`.

---

## How it works

```
every tool call
      │
      ▼
mode=yolo? ──yes──▶ ALLOW immediately
      │no
      ▼
ask list match? ──yes──▶ DENY  (tell Claude to surface for review)
      │no
      ▼
mode=ask? ──yes──▶ ALLOW immediately
      │no
      ▼
allow list match? ──yes──▶ ALLOW instantly
(skipped for compound
 Bash commands)  │no
                 ▼
         Claude Haiku API
         ├── safe=true  ──▶ ALLOW + write pattern to allow list
         └── safe=false ──▶ DENY  (AI's reason shown to Claude)
         └── error      ──▶ DENY  (fail safe)
```

Compound Bash commands (`&&`, `||`, `;`, `$(`, `` ` ``) always bypass the allow list and go straight to the AI — a safe-looking first token can't hide a dangerous second command.

---

## Requirements

- [Claude Code](https://claude.ai/code) installed
- Node.js ≥ 18
- An [Anthropic API key](https://console.anthropic.com/api-keys) (for the Haiku safety checks)

---

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/ai-gate
cd ai-gate
node install.js
```

The installer:
1. Creates a `.api-key` placeholder file
2. Adds the `PreToolUse` hook entry to `~/.claude/settings.json`

Then open `.api-key` and replace the placeholder with your `sk-ant-...` key:

```
sk-ant-api03-...
```

Restart Claude Code. That's it.

### Manual installation

If you prefer to wire it up yourself, add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/ai-gate/gate.js\""
          }
        ]
      }
    ]
  }
}
```

---

## Configuration

Edit `config.json` to customise your rules. The gate reloads it on every call — no restart needed.

### Rule syntax

```json
{ "tool": "ToolName", "pattern": "regex", "_note": "description" }
```

- `tool` — optional. If omitted, the rule matches any tool.
- `pattern` — optional regex, case-insensitive. Matched against the Bash command, file path, or full JSON input depending on the tool. If omitted, the rule matches any input for that tool.
- `_note` — ignored by the gate, just for your own documentation.

### Ask list

Commands you always want to review manually. The AI is skipped entirely.

```json
"ask": [
  { "tool": "Bash", "pattern": "rm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)" }
]
```

### Allow list

Commands that are auto-approved without any API call.

```json
"allow": [
  { "tool": "Read" },
  { "tool": "Bash", "pattern": "^git\\s" },
  { "tool": "Edit", "pattern": "^/home/you/projects/" }
]
```

### Auto-learning

When the AI approves an unknown command, ai-gate automatically adds a pattern to your allow list so future calls of the same type skip the API. Auto-learned rules are tagged with `"AI auto-learned: ..."` in the `_note` field and can be reviewed or removed at any time.

---

## API key

The key is read from `.api-key` (one line, no quotes). This keeps it out of Claude Code's environment so your main session continues to use your subscription.

Alternatively, set the `ANTHROPIC_API_KEY` environment variable at the OS level (not in `~/.claude/settings.json`). If you set it in `settings.json` it will route **all** Claude Code traffic through the API key, which is probably not what you want.

---

## Logs

Every decision is appended to `gate.log` as newline-delimited JSON:

```json
{"ts":"2026-03-25T02:12:25.091Z","decision":"allow","reason":null,"tool":"Read","subject":"src/index.ts"}
{"ts":"2026-03-25T02:12:25.143Z","decision":"deny","reason":"Blocked by ai-gate ask list","tool":"Bash","subject":"rm -rf ./node_modules"}
{"ts":"2026-03-25T02:12:26.182Z","decision":"allow","reason":"AI approved: chmod is standard dev tooling","tool":"Bash","subject":"chmod 755 build.sh"}
```

The file grows indefinitely — rotate or delete it as needed. It is excluded from git via `.gitignore`.

---

## Project structure

```
ai-gate/
├── gate.js            — the hook script (no dependencies)
├── config.json        — allow / ask rules
├── install.js         — one-time setup helper
├── commands/gate.md   — /gate slash command (installed to ~/.claude/commands/)
├── .mode              — current gate mode: on | ask | yolo (gitignored, defaults to "on")
├── .api-key           — your API key (gitignored, create after cloning)
├── gate.log           — decision log (gitignored, auto-created)
└── .gitignore
```

---

## License

MIT

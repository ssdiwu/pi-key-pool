# pi-key-pool

> API Key Pool Manager for [pi](https://github.com/earendil-works/pi) — session-based rotation, cooldown recovery, smart retry, and error classification.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why

When you have multiple API keys and want to:

- **Distribute load** across keys — each new conversation uses a different key
- **Auto-recover** from transient errors — failed keys cool down and come back automatically
- **Retry transparently** — when a key fails, switch to the next one and retry without user intervention
- **Debug easily** — see exactly what happened when things go wrong

## Features

| Feature | Description |
|---------|-------------|
| **Session-based binding** | Each session is bound to a unique key — parallel sessions use different keys automatically |
| **Cooldown recovery** | Failed keys enter timed cooldown, auto-recover when expired. No manual reset needed |
| **Smart retry** | On quota/capacity error → switch key → auto-retry last message. User sees nothing |
| **Error classification** | 3 tiers: `capacity` (30s) / `quota` (5min) / `network` (no switch). Independent strategy per type |
| **Zombie cleanup** | Auto-clean stale session bindings on startup (TTL: 1 hour) |
| **Auto provider detection** | Reads `provider` field from `keys.json`, auto-configures `models.json`. No hardcoded providers |
| **Debug mode** | Optional error logging to `.key-state`, visible in `/pool-status` |
| **Zero-config basics** | Drop keys in → works out of the box |

## Quick Start

```bash
# Install
pi install npm:pi-key-pool

# Or from git
pi install git:github.com/ssdiwu/pi-key-pool
```

Then configure your keys (see [Setup](#setup)).

## Setup

### 1. Create key pool

Edit `~/.pi/agent/key-pool/keys.json`:

```json
{
  "keys": [
    {
      "key": "tp-your-first-key-here",
      "provider": "xiaomi-token-plan-cn",
      "label": "primary"
    },
    {
      "key": "tp-your-second-key-here",
      "provider": "xiaomi-token-plan-cn",
      "label": "backup"
    }
  ]
}
```

> The `provider` field must match a pi provider name (e.g. `xiaomi-token-plan-cn`, `anthropic`, `openai-codex`). The extension auto-detects it and configures `models.json`.

### 2. Reload pi

```
/reload
```

That's it. The extension will:
- Auto-create `~/.pi/agent/key-pool/` directory on first load
- Auto-generate `pool-config.json` with defaults
- Auto-deploy `get-current-key.sh` into the runtime directory
- Auto-configure `models.json` with the correct provider + `!bash` injection

### 3. Verify

```
/pool-status
```

You should see something like:

```
Key Pool: 2 keys | #1 active | 0 cooling

  #1  tp-cuc...xxxxx... (primary)  — ◀ active
  #2  tp-cuq0...xxxxx... (backup)

Retry: 0/3 | Debug: OFF
Cooldowns: capacity=30s, quota=300s, network=off
```

## How It Works

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  keys.json  │────▶│ get-current-key  │────▶│   API Request    │
│  (key pool) │     │  .sh (!bash)     │     │  (correct key    │
└─────────────┘     │  reads session   │     │   injected)       │
                   │  + .key-state    │     └──────────────────┘
                   └──────────────────┘              │
                            ▲                         │
                            │                         │
                   ┌────────┴─────────┐             │
                   │  .key-state      │◀────────────┘
                   │  + .current-     │  session_start / turn_end
                   │    session       │
                   └──────────────────┘
```

### Lifecycle

```
/new (new session)
  ├─ session_start → generate sessionId → assignKeyToSession()
  ├─ write PI_KEY_POOL_SESSION_ID (process env) + .current-session fallback
  ├─ write .key-state (assignments)
  └─ Next request → !bash script reads session → outputs bound key ✅

Parallel sessions
  ├─ Session A → key #1 (exclusive)
  ├─ Session B → key #2 (exclusive)
  └─ Session C → key #1 (if released by A) ✅

API error (429/529)
  ├─ turn_end → classify error → mark cooled → reassign
  ├─ write .key-state (new assignment)
  └─ retryLastUserMessage() → transparent retry with new key ✅

Session ends (/new, /resume, exit)
  ├─ session_shutdown → releaseSessionAssignment()
  └─ Key becomes available for other sessions ✅

Cooldown expires
  └─ isCooled() returns false → key becomes eligible again ✅
```

## Configuration

### `~/.pi/agent/key-pool/pool-config.json` (auto-created)

```json
{
  "cooldownMs": {
    "capacity": 30000,
    "quota": 300000,
    "network": 0
  },
  "maxRetries": 3,
  "assignmentTtlMs": 3600000,
  "debug": false
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `cooldownMs.capacity` | `30000` (30s) | Overloaded / 529 errors — usually transient |
| `cooldownMs.quota` | `300000` (5min) | Rate limit / 429 errors — standard recovery |
| `cooldownMs.network` | `0` (no cooldown) | Network errors — don't blame the key |
| `maxRetries` | `3` | Max consecutive retries before giving up |
| `assignmentTtlMs` | `3600000` (1h) | TTL for stale session assignments (zombie cleanup) |
| `debug` | `false` | Enable error logging (see below) |

### `~/.pi/agent/key-pool/keys.json`

```json
{
  "keys": [
    { "key": "sk-or-tp-your-key", "provider": "your-provider", "label": "optional" }
  ]
}
```

| Field | Required | Description |
|-------|:--------:|-------------|
| `key` | ✅ | The API key string |
| `provider` | ✅ | pi provider name (auto-detected, used to configure models.json) |
| `label` | | Display name in `/pool-status` |

## Commands

| Command | Description |
|---------|-------------|
| `/pool-status` | Show pool health, active sessions, cooldown status, recent debug log |
| `/pool-reset` | Clear all cooldown marks and debug log |
| `/pool-clean` | Clean stale session bindings (zombie cleanup) |

### Example output (debug mode ON)

```
Key Pool: 3 keys | 2 sessions | 1 cooling

Current session: a7f52d8d... → key #2 (backup)

  #1  tp-cuc...xxxxx... (primary)  — sessions: 73be6226...  — ❄️ quota ~3m
  #2  tp-cuq0...xxxxx... (backup)  — sessions: a7f52d8d...
  #3  tp-cwzl...xxxxx... (test)    — ✅ quota (recovered)

Retry: 0/3 | Debug: ON
Cooldowns: capacity=30s, quota=300s, network=off
Assignment TTL: 60min

--- Debug Log ---
  [14:32:01] #1 (73be6226...) [quota] switch→#2: status_code: 429 rate limit exceeded
  [14:35:22] #2 (a7f52d8d...) [capacity] switch→#3: engine overloaded
```

## Error Classification

| Type | Patterns | Cooldown | Action |
|------|----------|----------|--------|
| **capacity** | `overloaded`, `capacity`, `529` | 30s | Switch + retry |
| **quota** | `429`, `rate limit`, `too many requests` | 5min | Switch + retry |
| **network** | `connection reset`, `timeout`, `fetch failed` | 0 (none) | Don't switch |
| **unknown** | anything else | 0 | Ignore |

Each type has independent cooldown and behavior. Network errors never trigger key switching — they're usually transient infrastructure issues.

## File Structure

```
📦 pi-key-pool/                    # npm package (git repo)
├── package.json                   # pi.extensions → "./extensions/index.ts"
├── extensions/
│   └── index.ts                   # Extension code (~600 lines)
├── keys.example.json              # Key pool template
├── pool-config.example.json       # Config template
├── .npmignore                     # Exclude runtime data from npm
└── README.md                      # This file

📂 ~/.pi/agent/key-pool/           # Runtime (auto-created)
├── keys.json                     # Your actual keys
├── pool-config.json              # Your config (optional)
├── .key-state                    # Runtime state (assignments + cooldowns)
├── .key-state.lock/              # Cross-process state lock (temporary)
├── .current-session              # Fallback session ID for shell script
└── get-current-key.sh            # Deployed shell script
```

## Design Decisions

### Why not modify auth.json directly?

pi loads `auth.json` **before** extensions are initialized. Writing to auth.json from an extension is too late — the current session would still use the old key.

Instead, we use `!bash get-current-key.sh` in `models.json`'s `apiKey` field. This executes on **every API request**, reading the latest `.key-state` plus `PI_KEY_POOL_SESSION_ID` (with `.current-session` as fallback) to output the correct key. No timing issues.

### Why session-based binding (not rotation)?

Previous design used rotation on `/new` — but this had a critical flaw: **parallel sessions could end up with the same key** due to race conditions on the shared state file.

Session-based binding solves this:
- **Each session gets exclusive key assignment** — no race conditions
- **Parallel sessions guaranteed different keys** — true load distribution
- **Session cleanup on exit** — keys are released when session ends
- **Zombie cleanup** — stale bindings auto-expire after TTL (1 hour)

### Why shell script instead of pure TS?

pi's `models.json` supports `!bash <command>` for dynamic apiKey resolution. This is the official mechanism for runtime key injection. The shell script is deployed automatically by the extension, reads assignment state, handles cooldown fallback, and outputs the chosen key.

## vs Alternatives

| Feature | **pi-key-pool** | [pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass) | [pi-high-availability](https://github.com/burggraf/pi-high-availability) |
|---------|:---:|:---:|:---:|
| Session binding | ✅ exclusive | ❌ | ❌ |
| Parallel sessions | ✅ guaranteed different keys | ❌ | ❌ |
| Cooldown recovery | ✅ time-based | ✅ 5min fixed | ✅ configurable |
| Auto-retry | ✅ transparent | ✅ | ✅ |
| Error classification | ✅ 3-tier | ❌ unified | ✅ 3-tier |
| Auto provider detect | ✅ from keys.json | ❌ manual | ❌ manual |
| Zombie cleanup | ✅ TTL-based | ❌ | ❌ |
| Debug logging | ✅ opt-in | ❌ | ❌ |
| Size | **~600 lines** | ~17K lines | ~400 lines |
| OAuth support | ❌ API keys only | ✅ full lifecycle | ✅ both |
| TUI panel | ❌ commands only | ✅ full TUI | ✅ accordion UI |

## Developing

```bash
# Clone
git clone https://github.com/ssdiwu/pi-key-pool.git
cd pi-key-pool

# Install locally (for testing)
pi install .

# Test with temporary load (no auto-load)
pi -e extensions/index.ts --print "hello" --no-session --provider <your-provider>

# Check pool status inside pi
/pool-status
```

## License

[MIT](LICENSE)

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
| **Session-based rotation** | New session (`/new`) → next available key. Same session keeps the same key (preserves prompt cache) |
| **Cooldown recovery** | Failed keys enter timed cooldown, auto-recover when expired. No manual reset needed |
| **Smart retry** | On quota/capacity error → switch key → auto-retry last message. User sees nothing |
| **Error classification** | 3 tiers: `capacity` (30s) / `quota` (5min) / `network` (no switch). Independent strategy per type |
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
└─────────────┘     │  reads .key-state │     │   injected)       │
                   └──────────────────┘     └──────────────────┘
                            ▲                         │
                            │                         │
                   ┌────────┴─────────┐             │
                   │  .key-state      │◀────────────┘
                   │  (managed by      │  session_start / turn_end
                   │   extension)     │
                   └──────────────────┘
```

### Lifecycle

```
/new (new session)
  ├─ session_start → rotateToNext() → write .key-state
  └─ Next request → !bash script reads new index → outputs new key ✅

Normal request (same session)
  └─ !bash script reads same index → outputs same key (cache preserved) ✅

API error (429/529)
  ├─ turn_end → classify error → mark cooled → rotateToNext()
  ├─ write .key-state (new index)
  └─ retryLastUserMessage() → transparent retry with new key ✅

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
  "retryOnSessionStart": true,
  "debug": false
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `cooldownMs.capacity` | `30000` (30s) | Overloaded / 529 errors — usually transient |
| `cooldownMs.quota` | `300000` (5min) | Rate limit / 429 errors — standard recovery |
| `cooldownMs.network` | `0` (no cooldown) | Network errors — don't blame the key |
| `maxRetries` | `3` | Max consecutive retries before giving up |
| `retryOnSessionStart` | `true` | Rotate key on `/new` |
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
| `/pool-status` | Show pool health, active key, cooldown status, recent debug log |
| `/pool-reset` | Clear all cooldown marks and debug log |

### Example output (debug mode ON)

```
Key Pool: 3 keys | #2 active | 1 cooling
Target: auth.json/xiaomi-token-plan-cn

  #1  tp-cuc...xxxxx... (primary)  — ❄️ quota ~3m
  #2  tp-cuq0...xxxxx... (backup)  — ◀ active
  #3  tp-cwzl...xxxxx... (test)    — ✅ quota (recovered)

Retry: 0/3 | Debug: ON
Cooldowns: capacity=30s, quota=300s, network=off

--- Debug Log ---
  [14:32:01] #1 [quota] switch→#2: status_code: 429 rate limit exceeded
  [14:35:22] #2 [capacity] switch→#3: engine overloaded
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
│   └── index.ts                   # Extension code (~416 lines)
├── get-current-key.sh             # Shell script template
├── keys.example.json              # Key pool template
├── pool-config.example.json       # Config template
├── .npmignore                     # Exclude runtime data from npm
└── README.md                      # This file

📂 ~/.pi/agent/key-pool/           # Runtime (auto-created)
├── keys.json                     # Your actual keys
├── pool-config.json              # Your config (optional)
├── .key-state                    # Runtime state (auto-managed)
└── get-current-key.sh            # Deployed shell script
```

## Design Decisions

### Why not modify auth.json directly?

pi loads `auth.json` **before** extensions are initialized. Writing to auth.json from an extension is too late — the current session would still use the old key.

Instead, we use `!bash get-current-key.sh` in `models.json`'s `apiKey` field. This executes on **every API request**, reading the latest `.key-state` and outputting the correct key. No timing issues.

### Why session-based rotation (not per-request)?

Per-request rotation would break prompt caching — every request would hit a different key, wasting cache warmth. Session-based rotation gives you:
- **Cache efficiency**: All requests in a session use the same key → warm cache
- **Load distribution**: Different sessions use different keys → spread across pool
- **Predictability**: You know which key is active via `/pool-status`

### Why shell script instead of pure TS?

pi's `models.json` supports `!bash <command>` for dynamic apiKey resolution. This is the official mechanism for runtime key injection. The shell script is minimal (~65 lines), reads JSON state, handles cooldown skipping, and outputs the chosen key.

## vs Alternatives

| Feature | **pi-key-pool** | [pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass) | [pi-high-availability](https://github.com/burggraf/pi-high-availability) |
|---------|:---:|:---:|:---:|
| Session rotation | ✅ unique | ❌ | ❌ |
| Cooldown recovery | ✅ time-based | ✅ 5min fixed | ✅ configurable |
| Auto-retry | ✅ transparent | ✅ | ✅ |
| Error classification | ✅ 3-tier | ❌ unified | ✅ 3-tier |
| Auto provider detect | ✅ from keys.json | ❌ manual | ❌ manual |
| Debug logging | ✅ opt-in | ❌ | ❌ |
| Size | **~480 lines** | ~17K lines | ~400 lines |
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

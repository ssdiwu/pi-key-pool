# pi-key-pool

API key pool manager for [pi](https://github.com/earendil-works/pi) coding agent.

## Features

- **Session-based rotation** — each new session (`/new`) automatically picks the next available key from the pool, preserving prompt cache within a session
- **Cooldown recovery** — failed keys enter a timed cooldown (configurable per error type) and auto-recover when expired, no manual reset needed
- **Smart retry** — on quota/capacity errors, automatically switches to the next healthy key and retries the last user message transparently
- **Error classification** — distinguishes capacity / quota / network errors with independent cooldown and retry strategies per type
- **Zero-config for basic use** — just drop your keys into `~/.pi/api-keys.txt`

## Install

```bash
# From npm (when published)
pi install npm:pi-key-pool

# Or from git
pi install git:github.com/yourname/pi-key-pool

# For development — symlink to your extensions dir
ln -s /path/to/pi-key-pool/extensions/index.ts ~/.pi/extensions/key-pool/index.ts
```

## Quick Start

1. Add your API keys (one per line) to `~/.pi/api-keys.txt`:

```
sk-ant-api03-first-key-here
sk-ant-api03-second-key-here
sk-ant-api03-third-key-here
```

2. Configure `~/.pi/models.json` to use the key pool:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "!bash ~/.pi/get-current-key.sh",
      "api": "anthropic-messages"
    }
  }
}
```

3. Restart pi (or `/reload`)

## Commands

| Command | Description |
|---------|-------------|
| `/pool-status` | View key pool health, current active key, cooldown status |
| `/pool-reset` | Manually clear all cooldown marks |

## Config

### `~/.pi/api-keys.txt`
One API key per line. Lines starting with `#` are comments.

### `~/.pi/pool-config.json` (optional)

```json
{
  "cooldownMs": {
    "capacity": 30000,
    "quota": 300000,
    "network": 0
  },
  "maxRetries": 3,
  "retryOnSessionStart": true
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `cooldownMs.capacity` | `30000` (30s) | Cooldown for overloaded/capacity errors |
| `cooldownMs.quota` | `300000` (5min) | Cooldown for rate-limit/quota errors |
| `cooldownMs.network` | `0` (no cooldown) | Network errors don't cool keys down |
| `maxRetries` | `3` | Max automatic retries before giving up |
| `retryOnSessionStart` | `true` | Rotate to next key on new session |

## How It Works

```
session_start → rotateToNext() → pick non-cooled key → notify user
     ↓
API request → !bash get-current-key.sh → read .key-state → output active key
     ↓
turn_end → check assistant message for errors
     ├─ network error   → retry same key immediately (no cooldown)
     ├─ capacity error  → mark cooled(30s) → switch key → retry
     └─ quota error     → mark cooled(5min) → switch key → retry
     ↓
cooldown expires → key becomes eligible again automatically
```

## Design Decisions (vs alternatives)

| Feature | pi-key-pool | pi-multi-pass | pi-high-availability |
|---------|-------------|---------------|---------------------|
| Session rotation | ✅ unique | ❌ | ❌ |
| Cooldown recovery | ✅ time-based | ✅ 5min fixed | ✅ configurable |
| Auto-retry | ✅ transparent | ✅ | ✅ |
| Error classification | ✅ 3-tier | ❌ unified | ✅ 3-tier |
| Size | ~350 lines | ~17K lines | ~400 lines |
| OAuth support | ❌ API keys only | ✅ full lifecycle | ✅ both |
| TUI management panel | ❌ commands only | ✅ full TUI | ✅ accordion UI |

## License

MIT

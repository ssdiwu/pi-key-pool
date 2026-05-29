# pi-key-pool

API key pool manager for [pi](https://github.com/earendil-works/pi) coding agent.

## Features

- **Session-based rotation** — each new session (`/new`) automatically picks the next available key from the pool, preserving prompt cache within a session
- **Cooldown recovery** — failed keys enter a timed cooldown (configurable per error type) and auto-recover when expired, no manual reset needed
- **Smart retry** — on quota/capacity errors, automatically switches to the next healthy key and retries the last user message transparently
- **Error classification** — distinguishes capacity / quota / network errors with independent cooldown and retry strategies per type
- **Debug logging** — optional debug mode preserves error details in state file for troubleshooting
- **Zero-config for basic use** — just drop your keys into the pool

## File Structure

All files live under `~/.pi/agent/key-pool/`:

```
~/.pi/agent/key-pool/
├── index.ts            # Extension main code
├── get-current-key.sh  # Shell script (called by models.json apiKey)
├── api-keys.txt        # Your API key pool (one per line)
├── pool-config.json    # Optional configuration
└── .key-state          # Runtime state (auto-managed)
```

## Install

```bash
# Clone or download to your preferred location
git clone https://github.com/yourname/pi-key-pool.git

# Copy extension to pi's agent directory
mkdir -p ~/.pi/agent/key-pool
cp pi-key-pool/extensions/index.ts       ~/.pi/agent/key-pool/index.ts
cp pi-key-pool/get-current-key.sh         ~/.pi/agent/key-pool/get-current-key.sh
chmod +x ~/.pi/agent/key-pool/get-current-key.sh

# Create config (optional, has sensible defaults)
cp pi-key-pool/pool-config.example.json  ~/.pi/agent/key-pool/pool-config.json
```

## Quick Start

1. Add your API keys (one per line) to `~/.pi/agent/key-pool/api-keys.txt`:

```
# Comments with # are ignored
tp-your-first-key-here
tp-your-second-key-here
tp-your-third-key-here
```

2. Configure `~/.pi/models.json` to use the key pool:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "!bash ~/.pi/agent/key-pool/get-current-key.sh",
      "api": "anthropic-messages"
    }
  }
}
```

3. Restart pi (or `/reload`)

## Commands

| Command | Description |
|---------|-------------|
| `/pool-status` | View key pool health, current active key, cooldown status, recent debug log |
| `/pool-reset` | Manually clear all cooldown marks and debug log |

## Config

### `~/.pi/agent/key-pool/api-keys.txt`
One API key per line. Lines starting with `#` are comments.

### `~/.pi/agent/key-pool/pool-config.json` (optional)

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
| `cooldownMs.capacity` | `30000` (30s) | Cooldown for overloaded/capacity errors |
| `cooldownMs.quota` | `300000` (5min) | Cooldown for rate-limit/quota errors |
| `cooldownMs.network` | `0` (no cooldown) | Network errors don't cool keys down |
| `maxRetries` | `3` | Max automatic retries before giving up |
| `retryOnSessionStart` | `true` | Rotate to next key on new session |
| `debug` | `false` | When `true`, preserves error details in `.key-state` and shows them in `/pool-status` |

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

### Error Classification

| Type | Patterns | Cooldown | Action |
|------|----------|----------|--------|
| **capacity** | overloaded, capacity, 529 | 30s | Switch + retry |
| **quota** | 429, rate limit, too many requests | 5min | Switch + retry |
| **network** | connection reset, timeout, fetch failed | 0 (none) | Don't switch, let pi handle |
| **unknown** | anything else | 0 | Ignore |

### Debug Mode

When `"debug": true` is set in config:

- Error details are appended to `.key-state.debugLog[]` (last 50 entries kept)
- `/pool-status` shows recent error log with timestamps
- Max-retries notification includes the actual error message
- Network error notifications include the raw error text
- `/pool-reset` clears both cooldown marks and debug log

## Design Decisions (vs alternatives)

| Feature | pi-key-pool | pi-multi-pass | pi-high-availability |
|---------|-------------|---------------|---------------------|
| Session rotation | ✅ unique | ❌ | ❌ |
| Cooldown recovery | ✅ time-based | ✅ 5min fixed | ✅ configurable |
| Auto-retry | ✅ transparent | ✅ | ✅ |
| Error classification | ✅ 3-tier | ❌ unified | ✅ 3-tier |
| Debug logging | ✅ opt-in | ❌ | ❌ |
| Size | ~550 lines | ~17K lines | ~400 lines |
| OAuth support | ❌ API keys only | ✅ full lifecycle | ✅ both |
| TUI management panel | ❌ commands only | ✅ full TUI | ✅ accordion UI |

## Testing

```bash
# Test shell script directly
~/.pi/agent/key-pool/get-current-key.sh

# Check pool status (after loading extension)
/pool-status

# Reset all cooldowns
/pool-reset
```

## License

MIT

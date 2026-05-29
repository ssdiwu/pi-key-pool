#!/bin/bash
# 读取 ~/.pi/agent/key-pool/ 状态，输出当前应使用的 API key
# 由 pi-key-pool extension 在轮换时维护 .key-state
# 兼容 macOS bash 3.x

AGENT_DIR="$HOME/.pi/agent/key-pool"
KEYS_FILE="$AGENT_DIR/keys.json"
STATE_FILE="$AGENT_DIR/.key-state"

if [ ! -f "$KEYS_FILE" ]; then
  echo "ERROR: $KEYS_FILE not found" >&2
  exit 1
fi

# 用 python3 从 JSON 提取 key 数组并找到当前活跃的
python3 -c "
import json, sys, time

try:
    with open('$KEYS_FILE') as f:
        data = json.load(f)
    arr = data if isinstance(data, list) else data.get('keys', [])
    keys = [e.get('key') if isinstance(e, dict) else e for e in arr if e]

    if not keys:
        print('ERROR: no keys in $KEYS_FILE', file=sys.stderr)
        sys.exit(1)

    # 读状态获取 index
    idx = 0
    try:
        with open('$STATE_FILE') as f:
            state = json.load(f)
        idx = state.get('index', 0)
    except:
        pass

    idx = idx % len(keys)

    # 检查冷却：如果当前 key 冷却中，找下一个非冷却的
    cooled = {}
    try:
        with open('$STATE_FILE') as f:
            state = json.load(f)
        cooled = state.get('cooled', {})
    except:
        pass

    def is_cooled(i):
        e = cooled.get(str(i))
        if not e: return False
        return time.time() * 1000 - e['exhaustedAt'] < e['cooldownMs']

    if is_cooled(idx):
        for offset in range(1, len(keys) + 1):
            cand = (idx + offset) % len(keys)
            if not is_cooled(cand):
                idx = cand
                break

    print(keys[idx])

except Exception as ex:
    print(f'ERROR: {ex}', file=sys.stderr)
    sys.exit(1)
" 2>/dev/null
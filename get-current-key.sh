#!/bin/bash
# 读取 ~/.pi/agent/key-pool/.key-state 获取当前应使用的 key 索引
# 由 pi-key-pool extension 在 session_start / 失败时维护
# 支持冷却期自动跳过
# 兼容 macOS bash 3.x（无 mapfile）

AGENT_DIR="$HOME/.pi/agent/key-pool"
KEYS_FILE="$AGENT_DIR/api-keys.txt"
STATE_FILE="$AGENT_DIR/.key-state"

if [ ! -f "$KEYS_FILE" ]; then
  echo "ERROR: $KEYS_FILE not found" >&2
  exit 1
fi

# 过滤掉注释和空行，读取有效 keys 到数组（兼容 bash 3.x）
KEYS=()
while IFS= read -r line; do
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  KEYS+=("$line")
done < "$KEYS_FILE"

TOTAL=${#KEYS[@]}

if [ "$TOTAL" -eq 0 ]; then
  echo "ERROR: no valid keys in $KEYS_FILE" >&2
  exit 1
fi

# 读状态文件（JSON 格式）
INDEX=0
if [ -f "$STATE_FILE" ]; then
  # 用简单方式提取 index 字段
  INDEX=$(grep -o '"index": *[0-9]*' "$STATE_FILE" | head -1 | grep -o '[0-9]*')

  # 校验范围
  if ! [[ "$INDEX" =~ ^[0-9]+$ ]] || [ "$INDEX" -ge "$TOTAL" ]; then
    INDEX=0
  fi

  # 检查当前 key 是否在冷却中
  CURRENT_COOL=$(python3 -c "
import json, sys, time
try:
    with open('$STATE_FILE') as f:
        state = json.load(f)
    entry = state.get('cooled', {}).get(str($INDEX))
    if entry:
        exhausted = entry.get('exhaustedAt', 0)
        cooldown = entry.get('cooldownMs', 0)
        if time.time() * 1000 - exhausted < cooldown:
            print('COOLED')
            sys.exit(0)
except Exception:
    pass
print('OK')
" 2>/dev/null)

  if [ "$CURRENT_COOL" = "COOLED" ]; then
    # 当前 key 在冷却中 — 尝试找下一个非冷却的
    for i in $(seq 1 $TOTAL); do
      NEXT=$(( (INDEX + i) % TOTAL ))
      NEXT_COOL=$(python3 -c "
import json, sys, time
try:
    with open('$STATE_FILE') as f:
        state = json.load(f)
    entry = state.get('cooled', {}).get(str($NEXT))
    if entry:
        exhausted = entry.get('exhaustedAt', 0)
        cooldown = entry.get('cooldownMs', 0)
        if time.time() * 1000 - exhausted < cooldown:
            print('COOLED')
            sys.exit(0)
except Exception:
    pass
print('OK')
" 2>/dev/null)
      if [ "$NEXT_COOL" = "OK" ]; then
        INDEX=$NEXT
        break
      fi
    done
  fi
fi

echo "${KEYS[$INDEX]}"

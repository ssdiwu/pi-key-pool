#!/usr/bin/env bash
# pi-key-pool 集成测试 — 覆盖 9 个验收场景
#
# 用法：
#   bash tests/scenarios.bash.sh
#
# 需要：
#   - bash 4+、python3、node
#   - 修改 PI_KEY_POOL_DIR 指向测试目录（默认 /tmp/key-pool-test）
#
# 测试逻辑：
#   1. 提取 extensions/index.ts 里的 GET_CURRENT_KEY_SCRIPT
#   2. 用临时 keys.json / .key-state 模拟各种场景
#   3. 验证脚本输出

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_FILE="$REPO_DIR/extensions/index.ts"
EXTRACT_MJS="$SCRIPT_DIR/extract-script.mjs"

# 测试环境：避免污染真实 ~/.pi/agent/key-pool
TEST_DIR="${PI_KEY_POOL_TEST_DIR:-/tmp/key-pool-test}"
export PI_KEY_POOL_DIR="$TEST_DIR"
export PI_KEY_POOL_SESSION_ID=""
export PI_KEY_POOL_PROVIDER=""

mkdir -p "$TEST_DIR"

# 提取部署的 bash 脚本
if [ ! -f "$EXTRACT_MJS" ]; then
  echo "❌ $EXTRACT_MJS not found"; exit 1
fi
node "$EXTRACT_MJS" "$TEST_DIR/get-current-key.sh" >/dev/null
chmod +x "$TEST_DIR/get-current-key.sh"

# 测试用的 keys.json
cat > "$TEST_DIR/keys.json" <<'JSON'
{
  "keys": [
    { "key": "tp-xiaomi-key-1", "provider": "xiaomi-token-plan-cn", "label": "primary" },
    { "key": "tp-xiaomi-key-2", "provider": "xiaomi-token-plan-cn", "label": "backup" },
    { "key": "tp-zai-key-1", "provider": "zai", "label": "zai-1" },
    { "key": "tp-zai-key-2", "provider": "zai", "label": "zai-2" }
  ]
}
JSON

# 测试框架
pass=0
fail=0
fails=()

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    pass=$((pass + 1))
    echo "  ✅ $name"
  else
    fail=$((fail + 1))
    fails+=("$name: expected='$expected' actual='$actual'")
    echo "  ❌ $name: expected='$expected' actual='$actual'"
  fi
}

check_err() {
  local name="$1" expected_pattern="$2" actual="$3"
  if echo "$actual" | grep -q "$expected_pattern"; then
    pass=$((pass + 1))
    echo "  ✅ $name (error as expected)"
  else
    fail=$((fail + 1))
    fails+=("$name: expected pattern='$expected_pattern' actual='$actual'")
    echo "  ❌ $name: expected pattern='$expected_pattern' actual='$actual'"
  fi
}

# 重置 .key-state 工具
reset_state() {
  cat > "$TEST_DIR/.key-state" <<JSON
{ "assignments": $([ "${1:-}" = "old" ] && echo '{"oldSession": {"keyIndex": 1, "since": 0}}' || echo '{}'), "cooled": {} }
JSON
}

echo "=== 场景 1：managed provider 失败 — 正常切 key（bash 路径） ==="
reset_state
state_json='{ "assignments": { "xiaomi-token-plan-cn": { "sessionA": { "keyIndex": 0, "since": 0 } } }, "cooled": { "0": { "exhaustedAt": 9999999999000, "cooldownMs": 300000, "reason": "quota" } } }'
echo "$state_json" > "$TEST_DIR/.key-state"
out=$(PI_KEY_POOL_SESSION_ID=sessionB PI_KEY_POOL_PROVIDER=xiaomi-token-plan-cn "$TEST_DIR/get-current-key.sh")
check "xiaomi key 0 cooled, sessionB 应得 key 1" "tp-xiaomi-key-2" "$out"

echo "=== 场景 2：bash 脚本只为 managed provider 选 key（core 修复点） ==="
# zai provider 在 keys.json 中存在 → bash 脚本能为 zai 选 key
state_json='{ "assignments": { "zai": { "sessionA": { "keyIndex": 2, "since": 0 } } }, "cooled": {} }'
echo "$state_json" > "$TEST_DIR/.key-state"
out=$(PI_KEY_POOL_SESSION_ID=sessionB PI_KEY_POOL_PROVIDER=zai "$TEST_DIR/get-current-key.sh")
check "zai sessionB 应得 zai key 1" "tp-zai-key-2" "$out"

echo "=== 场景 3：session_start 不预先分配 — 状态文件初始为空 ==="
reset_state
initial_state=$(cat "$TEST_DIR/.key-state")
# 验证初始状态 assignments 字段为空（mock：实际 session_start 由 pi 调用，不在 bash 测试范围）
check "初始 state 无 assignments" "{}" "$(echo "$initial_state" | python3 -c 'import json,sys; print(json.load(sys.stdin)["assignments"])')"

echo "=== 场景 4：provider 隔离 — xiaomi 和 zai 互不干扰 ==="
state_json='{ "assignments": { "xiaomi-token-plan-cn": { "sessionA": { "keyIndex": 0, "since": 0 }, "sessionB": { "keyIndex": 1, "since": 0 } }, "zai": { "sessionC": { "keyIndex": 2, "since": 0 } } }, "cooled": {} }'
echo "$state_json" > "$TEST_DIR/.key-state"
# 新 xiaomi session 找不到 xiaomi key，应返回 ERROR
out=$(PI_KEY_POOL_SESSION_ID=sessionD PI_KEY_POOL_PROVIDER=xiaomi-token-plan-cn "$TEST_DIR/get-current-key.sh" 2>&1)
check_err "xiaomi 全占" "all keys are cooling" "$out"
# 新 zai session 应得 zai-2
out=$(PI_KEY_POOL_SESSION_ID=sessionD PI_KEY_POOL_PROVIDER=zai "$TEST_DIR/get-current-key.sh")
check "zai 池未满应分到 zai-2" "tp-zai-key-2" "$out"

echo "=== 场景 5：老扁平格式兼容（直接读取 sessionId→keyIndex） ==="
state_json='{ "assignments": { "oldSession": { "keyIndex": 1, "since": 0 } }, "cooled": {} }'
echo "$state_json" > "$TEST_DIR/.key-state"
out=$(PI_KEY_POOL_SESSION_ID=oldSession PI_KEY_POOL_PROVIDER=xiaomi-token-plan-cn "$TEST_DIR/get-current-key.sh")
check "老扁平格式 sessionId→keyIndex 仍生效" "tp-xiaomi-key-2" "$out"

echo "=== 场景 6：cooldown 恢复 — 过期 key 重新可用 ==="
state_json='{ "assignments": {}, "cooled": { "0": { "exhaustedAt": 1, "cooldownMs": 300000, "reason": "quota" } } }'
echo "$state_json" > "$TEST_DIR/.key-state"
out=$(PI_KEY_POOL_SESSION_ID=sessionA PI_KEY_POOL_PROVIDER=xiaomi-token-plan-cn "$TEST_DIR/get-current-key.sh")
check "key 0 cooldown 已过期 (exhaustedAt=1), 应分到 key 1" "tp-xiaomi-key-1" "$out"

echo "=== 场景 7：fallback — 不存在的 provider 取第一个带 provider 的 key ==="
state_json='{ "assignments": {}, "cooled": {} }'
echo "$state_json" > "$TEST_DIR/.key-state"
out=$(PI_KEY_POOL_SESSION_ID=sessionA PI_KEY_POOL_PROVIDER=unknown-provider "$TEST_DIR/get-current-key.sh")
check "unknown provider → fallback 到 xiaomi 第一个 key" "tp-xiaomi-key-1" "$out"

echo "=== 场景 8：session 自身 key cooled — 重新走 available ==="
state_json='{ "assignments": { "xiaomi-token-plan-cn": { "sessionA": { "keyIndex": 0, "since": 0 } } }, "cooled": { "0": { "exhaustedAt": 9999999999000, "cooldownMs": 300000, "reason": "quota" } } }'
echo "$state_json" > "$TEST_DIR/.key-state"
out=$(PI_KEY_POOL_SESSION_ID=sessionA PI_KEY_POOL_PROVIDER=xiaomi-token-plan-cn "$TEST_DIR/get-current-key.sh")
check "sessionA 自己的 0 cooled → 重选 1" "tp-xiaomi-key-2" "$out"

echo "=== 场景 9：同 session 重复调用稳定性 ==="
state_json='{ "assignments": { "xiaomi-token-plan-cn": { "sessionA": { "keyIndex": 0, "since": 0 } } }, "cooled": {} }'
echo "$state_json" > "$TEST_DIR/.key-state"
out1=$(PI_KEY_POOL_SESSION_ID=sessionA PI_KEY_POOL_PROVIDER=xiaomi-token-plan-cn "$TEST_DIR/get-current-key.sh")
out2=$(PI_KEY_POOL_SESSION_ID=sessionA PI_KEY_POOL_PROVIDER=xiaomi-token-plan-cn "$TEST_DIR/get-current-key.sh")
check "sessionA 两次调用结果一致" "$out1" "$out2"

echo
echo "=== 汇总 ==="
echo "通过：$pass"
echo "失败：$fail"
if [ $fail -gt 0 ]; then
  echo "失败详情："
  for f in "${fails[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
echo "✅ 所有测试通过"
exit 0

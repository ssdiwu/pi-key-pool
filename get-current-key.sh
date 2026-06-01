#!/bin/bash
# 读取 ~/.pi/agent/key-pool/ 状态，输出当前 session 应使用的 API key。
# 优先使用 PI_KEY_POOL_SESSION_ID，fallback 到 .current-session。
# 按 PI_KEY_POOL_PROVIDER 过滤（未设置时取 keys.json 第一个非空 provider）。

set -euo pipefail

AGENT_DIR="${PI_KEY_POOL_DIR:-$HOME/.pi/agent/key-pool}"
export KEYS_FILE="${AGENT_DIR}/keys.json"
export STATE_FILE="${AGENT_DIR}/.key-state"
export SESSION_FILE="${AGENT_DIR}/.current-session"

python3 <<'PY'
import json
import os
import sys
import time

keys_file = os.environ["KEYS_FILE"]
state_file = os.environ["STATE_FILE"]
session_file = os.environ["SESSION_FILE"]

try:
    with open(keys_file, encoding="utf-8") as f:
        data = json.load(f)
    arr = data if isinstance(data, list) else data.get("keys", [])

    # 收集所有非空 key，按 provider 索引
    items = []  # list of {"key": str, "provider": str|None, "index": int}
    for i, item in enumerate(arr):
        if not isinstance(item, dict):
            continue
        key = item.get("key")
        if not (isinstance(key, str) and key.strip()):
            continue
        provider = item.get("provider")
        if isinstance(provider, str):
            provider = provider.strip() or None
        else:
            provider = None
        items.append({"key": key.strip(), "provider": provider, "index": i})

    if not items:
        print(f"ERROR: no keys in {keys_file}", file=sys.stderr)
        sys.exit(1)

    requested_provider = os.environ.get("PI_KEY_POOL_PROVIDER")
    provider_key_indexes = []
    if requested_provider:
        provider_key_indexes = [it["index"] for it in items if it["provider"] == requested_provider]
        if not provider_key_indexes:
            # fallback: provider 未配置，使用第一个非空 key
            provider_key_indexes = [it["index"] for it in items if it["provider"]][:1] or [items[0]["index"]]
    else:
        # 未指定 provider: 使用第一个带 provider 的 key，否则取第一个
        with_provider = [it for it in items if it["provider"]]
        if with_provider:
            provider_key_indexes = [with_provider[0]["index"]]
        else:
            provider_key_indexes = [items[0]["index"]]

    # 计算全局 key 索引位置（用于在 keys 数组中取 key 字符串）
    key_strings = [it["key"] for it in items]

    state = {}
    try:
        with open(state_file, encoding="utf-8") as f:
            state = json.load(f)
    except FileNotFoundError:
        state = {}

    session_id = os.environ.get("PI_KEY_POOL_SESSION_ID")
    if not session_id:
        try:
            with open(session_file, encoding="utf-8") as f:
                session_id = f.read().strip() or None
        except FileNotFoundError:
            session_id = None

    cooled = state.get("cooled", {}) if isinstance(state, dict) else {}

    def is_cooled(index):
        entry = cooled.get(str(index))
        if not isinstance(entry, dict):
            return False
        try:
            return time.time() * 1000 - float(entry["exhaustedAt"]) < float(entry["cooldownMs"])
        except Exception:
            return False

    idx = None
    assignments = state.get("assignments", {}) if isinstance(state, dict) else {}
    if session_id and isinstance(assignments, dict):
        # 嵌套新格式: assignments[provider][sessionId]
        if requested_provider:
            bucket = assignments.get(requested_provider)
            if isinstance(bucket, dict):
                a = bucket.get(session_id)
                if isinstance(a, dict) and isinstance(a.get("keyIndex"), int):
                    idx = a["keyIndex"]
        # 老扁平格式: assignments[sessionId]（兼容）
        if idx is None:
            a = assignments.get(session_id)
            if isinstance(a, dict) and isinstance(a.get("keyIndex"), int):
                idx = a["keyIndex"]

    if idx is None and isinstance(state.get("index"), int):
        idx = state["index"]

    available = []
    for i in provider_key_indexes:
        if is_cooled(i):
            continue
        # 跳过已被该 provider 其他 session 占用的 key（嵌套新格式；当前 session 自己的绑定保留）
        if requested_provider and isinstance(assignments.get(requested_provider), dict):
            bucket = assignments[requested_provider]
            taken = any(
                isinstance(a, dict) and a.get("keyIndex") == i
                for sid, a in bucket.items()
                if sid != session_id and a is not None
            )
            if taken:
                continue
        # 老扁平格式的 assignments（顶层 key 是 sessionId 而非 provider）已被
        # getProviderAssignments() 视为空，新代码不会拿它们当约束。这里不再检查。
        available.append(i)
    if not available:
        remaining = []
        now = time.time() * 1000
        for entry in cooled.values():
            if not isinstance(entry, dict):
                continue
            try:
                left = float(entry["cooldownMs"]) - (now - float(entry["exhaustedAt"]))
                if left > 0:
                    remaining.append(left)
            except Exception:
                pass
        wait = ""
        if remaining:
            secs = int((min(remaining) + 999) // 1000)
            wait = f"; next key available in {secs}s" if secs < 60 else f"; next key available in ~{(secs + 59) // 60}m"
        print(f"ERROR: all keys are cooling{wait}", file=sys.stderr)
        sys.exit(2)

    if idx is None or idx not in provider_key_indexes or is_cooled(idx):
        idx = available[0]

    print(key_strings[idx])
except Exception as ex:
    print(f"ERROR: {ex}", file=sys.stderr)
    sys.exit(1)
PY

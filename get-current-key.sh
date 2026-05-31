#!/bin/bash
# 读取 ~/.pi/agent/key-pool/ 状态，输出当前 session 应使用的 API key。
# 优先使用 PI_KEY_POOL_SESSION_ID，fallback 到 .current-session。

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
    keys = []
    for item in arr:
        if isinstance(item, dict):
            key = item.get("key")
        else:
            key = item
        if isinstance(key, str) and key.strip():
            keys.append(key.strip())

    if not keys:
        print(f"ERROR: no keys in {keys_file}", file=sys.stderr)
        sys.exit(1)

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
        assignment = assignments.get(session_id)
        if isinstance(assignment, dict) and isinstance(assignment.get("keyIndex"), int):
            idx = assignment["keyIndex"]

    if idx is None and isinstance(state.get("index"), int):
        idx = state["index"]

    if idx is None or idx < 0 or idx >= len(keys) or is_cooled(idx):
        idx = next((i for i in range(len(keys)) if not is_cooled(i)), 0)

    print(keys[idx % len(keys)])
except Exception as ex:
    print(f"ERROR: {ex}", file=sys.stderr)
    sys.exit(1)
PY

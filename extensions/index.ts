/**
 * pi-key-pool — API Key Pool Manager for pi
 *
 * 核心能力：
 *   1. Session 绑定   — 每个 session 独占一个 key，完全隔离
 *   2. 冷却恢复       — 失败 key 带时间戳标记，到期自动恢复
 *   3. 自动重试       — 切换 key 后自动重发上一条用户消息，并在连续 429 时熔断
 *   4. 错误分类       — capacity / quota / network 三类独立策略
 *   5. 僵尸清理       — 启动时清理超时的 assignments
 */

import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── 路径常量 ────────────────────────────────────────────────

const HOME = process.env.HOME || homedir();
const AGENT_DIR = join(HOME, ".pi", "agent", "key-pool");
const KEYS_FILE = join(AGENT_DIR, "keys.json");
const STATE_FILE = join(AGENT_DIR, ".key-state");
const LOCK_DIR = join(AGENT_DIR, ".key-state.lock");
const CONFIG_FILE = join(AGENT_DIR, "pool-config.json");
const SESSION_FILE = join(AGENT_DIR, ".current-session");
const SCRIPT_FILE = join(AGENT_DIR, "get-current-key.sh");
const MODELS_FILE = join(HOME, ".pi", "agent", "models.json");

// ── 类型定义 ─────────────────────────────────────────────────

interface CooldownEntry {
	exhaustedAt: number;
	cooldownMs: number;
	reason: ErrorType;
}

interface Assignment {
	keyIndex: number;
	since: number;
}

interface KeyState {
	/**
	 * 按 provider 分桶的 session 绑定。
	 * 新格式：{ [provider]: { [sessionId]: Assignment } }
	 * 老格式（兼容读取）：{ [sessionId]: Assignment } — 读不到时直接当空处理
	 */
	assignments: Record<string, Assignment> | Record<string, Record<string, Assignment>>;
	cooled: Record<string, CooldownEntry>;
	/** legacy global counter, kept for migration */
	retryCount: number;
	retryCounts?: Record<string, number>;
	debugLog?: DebugEntry[];
}

interface DebugEntry {
	timestamp: number;
	keyIndex: number;
	sessionId: string;
	errorType: ErrorType;
	errorMessage: string;
	action: string;
}

type ErrorType = "capacity" | "quota" | "network" | "unknown";

interface ErrorClassification {
	type: ErrorType;
	shouldSwitch: boolean;
}

interface KeyEntry {
	key: string;
	/** 关联的 pi provider 名称（如 xiaomi-token-plan-cn） */
	provider?: string;
	label?: string;
}

interface PoolConfig {
	cooldownMs: { capacity: number; quota: number; network: number };
	maxRetries: number;
	assignmentTtlMs: number;
	debug: boolean;
}

const DEFAULT_CONFIG: PoolConfig = {
	cooldownMs: { capacity: 30_000, quota: 300_000, network: 0 },
	maxRetries: 3,
	assignmentTtlMs: 3600_000,
	debug: false,
};

// ── Shell 脚本（安装时部署到运行目录）─────────────────────────

const GET_CURRENT_KEY_SCRIPT = `#!/bin/bash
# 读取 ~/.pi/agent/key-pool/ 状态，输出当前 session 应使用的 API key。
# 优先使用 PI_KEY_POOL_SESSION_ID，fallback 到 .current-session。
# 按 PI_KEY_POOL_PROVIDER 过滤（未设置时取 keys.json 第一个非空 provider）。

set -euo pipefail

AGENT_DIR="\${PI_KEY_POOL_DIR:-$HOME/.pi/agent/key-pool}"
export KEYS_FILE="\${AGENT_DIR}/keys.json"
export STATE_FILE="\${AGENT_DIR}/.key-state"
export SESSION_FILE="\${AGENT_DIR}/.current-session"

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
`;

// ── 通用工具 ─────────────────────────────────────────────────

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function secureFile(path: string, mode: number): void {
	try { chmodSync(path, mode); } catch { /* ignore */ }
}

function shellQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

function numberOr(value: unknown, fallback: number, min = 0): number {
	return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

function normalizeConfig(input: unknown): PoolConfig {
	const raw = input && typeof input === "object" ? input as Record<string, any> : {};
	const cooldownMs = raw.cooldownMs && typeof raw.cooldownMs === "object" ? raw.cooldownMs : {};
	return {
		cooldownMs: {
			capacity: numberOr(cooldownMs.capacity, DEFAULT_CONFIG.cooldownMs.capacity),
			quota: numberOr(cooldownMs.quota, DEFAULT_CONFIG.cooldownMs.quota),
			network: numberOr(cooldownMs.network, DEFAULT_CONFIG.cooldownMs.network),
		},
		maxRetries: numberOr(raw.maxRetries, DEFAULT_CONFIG.maxRetries, 0),
		assignmentTtlMs: numberOr(raw.assignmentTtlMs, DEFAULT_CONFIG.assignmentTtlMs, 1_000),
		debug: raw.debug === true,
	};
}

function withStateLock<T>(fn: () => T): T {
	const startedAt = Date.now();
	let acquired = false;
	while (!acquired) {
		try {
			mkdirSync(LOCK_DIR);
			writeFileSync(join(LOCK_DIR, "owner"), `${process.pid}:${Date.now()}`, "utf-8");
			acquired = true;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(LOCK_DIR).mtimeMs > 10_000) rmSync(LOCK_DIR, { recursive: true, force: true });
			} catch { /* ignore stale-lock cleanup errors */ }
			if (Date.now() - startedAt > 5_000) throw new Error("key-pool: timed out waiting for state lock");
			sleepSync(25);
		}
	}

	try {
		return fn();
	} finally {
		rmSync(LOCK_DIR, { recursive: true, force: true });
	}
}

// ── 文件读写 ─────────────────────────────────────────────────

function loadConfig(): PoolConfig {
	try {
		if (!existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
		const raw = readFileSync(CONFIG_FILE, "utf-8").trim();
		return raw ? normalizeConfig(JSON.parse(raw)) : DEFAULT_CONFIG;
	} catch { return DEFAULT_CONFIG; }
}

function writeConfig(config: PoolConfig): void {
	writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
	secureFile(CONFIG_FILE, 0o600);
}

function migrateConfig(): void {
	try {
		if (!existsSync(CONFIG_FILE)) return;
		const raw = readFileSync(CONFIG_FILE, "utf-8").trim();
		if (!raw) return;
		const existing = JSON.parse(raw);
		const normalized = normalizeConfig(existing);
		if (JSON.stringify(existing) !== JSON.stringify(normalized)) writeConfig(normalized);
	} catch { /* keep startup non-blocking */ }
}

function freshState(): KeyState {
	return { assignments: {}, cooled: {}, retryCount: 0, retryCounts: {} };
}

function loadStateUnlocked(): KeyState {
	try {
		if (!existsSync(STATE_FILE)) return freshState();
		const raw = readFileSync(STATE_FILE, "utf-8").trim();
		if (!raw) return freshState();
		const parsed = JSON.parse(raw);
		if (!parsed.assignments && typeof parsed.index === "number") {
			return { assignments: {}, cooled: parsed.cooled || {}, retryCount: parsed.retryCount || 0, retryCounts: {}, debugLog: parsed.debugLog };
		}
		return { ...freshState(), ...parsed, retryCounts: parsed.retryCounts || {} };
	} catch { return freshState(); }
}

function saveStateUnlocked(state: KeyState): void {
	const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, JSON.stringify(state), { encoding: "utf-8", mode: 0o600 });
	renameSync(tmp, STATE_FILE);
	secureFile(STATE_FILE, 0o600);
}

function loadState(): KeyState {
	return withStateLock(() => loadStateUnlocked());
}

function updateState<T>(mutator: (state: KeyState) => T): T {
	return withStateLock(() => {
		const state = loadStateUnlocked();
		const result = mutator(state);
		saveStateUnlocked(state);
		return result;
	});
}

function readKeys(): KeyEntry[] {
	try {
		if (!existsSync(KEYS_FILE)) return [];
		const raw = readFileSync(KEYS_FILE, "utf-8").trim();
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		const arr = Array.isArray(parsed) ? parsed : parsed.keys ?? [];
		return arr
			.filter((e: any) => e && typeof e.key === "string" && e.key.trim().length > 0)
			.map((e: any) => ({ ...e, key: e.key.trim() }));
	} catch { return []; }
}

/** 收集 keys.json 中出现的所有非空 provider 集合。 */
function getManagedProviders(): Set<string> {
	const out = new Set<string>();
	for (const k of readKeys()) {
		if (k.provider && k.provider.trim()) out.add(k.provider);
	}
	return out;
}

/** 当前 provider 是否被 key-pool 管理（即 keys.json 中存在该 provider 的 key）。 */
function isManagedProvider(provider: string | undefined | null): boolean {
	if (!provider) return false;
	return getManagedProviders().has(provider);
}

/** 按 provider 分组 keys；保留每个 key 在原始 keys 数组中的 index。 */
function groupKeysByProvider(keys: KeyEntry[]): Record<string, Array<{ entry: KeyEntry; index: number }>> {
	const groups: Record<string, Array<{ entry: KeyEntry; index: number }>> = {};
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i];
		if (!k.provider) continue;
		(groups[k.provider] ??= []).push({ entry: k, index: i });
	}
	return groups;
}

function writeSessionId(sessionId: string): void {
	writeFileSync(SESSION_FILE, sessionId, { encoding: "utf-8", mode: 0o600 });
	secureFile(SESSION_FILE, 0o600);
}

function removeSessionFile(sessionId: string): void {
	try {
		if (existsSync(SESSION_FILE) && readFileSync(SESSION_FILE, "utf-8").trim() === sessionId) unlinkSync(SESSION_FILE);
	} catch { /* ignore */ }
}

function deployGetCurrentKeyScript(): void {
	writeFileSync(SCRIPT_FILE, GET_CURRENT_KEY_SCRIPT, { encoding: "utf-8", mode: 0o700 });
	secureFile(SCRIPT_FILE, 0o700);
}

// ── 错误分类 ─────────────────────────────────────────────────

function classifyError(msg?: string): ErrorClassification {
	if (!msg) return { type: "unknown", shouldSwitch: false };
	const lower = msg.toLowerCase();

	const CAPACITY_PATTERNS = [/status_code:? *529/i, /\b529\b/i, /capacity/i, /no capacity/i, /engine overloaded/i, /overloaded/i];
	if (CAPACITY_PATTERNS.some((p) => p.test(lower))) return { type: "capacity", shouldSwitch: true };

	const QUOTA_PATTERNS = [/status_code:? *429/i, /\b429\b/i, /rate.?limit/i, /too many requests/i, /insufficient quota/i];
	if (QUOTA_PATTERNS.some((p) => p.test(lower))) return { type: "quota", shouldSwitch: true };

	const NETWORK_PATTERNS = [
		/internal network failure/i, /network failure/i, /connection reset/i, /connection refused/i,
		/etimedout/i, /econnreset/i, /econnrefused/i, /socket hang up/i, /fetch failed/i, /timeout/i,
	];
	if (NETWORK_PATTERNS.some((p) => p.test(lower))) return { type: "network", shouldSwitch: false };

	return { type: "unknown", shouldSwitch: false };
}

// ── 冷却判断 ─────────────────────────────────────────────────

function isCooled(entry: CooldownEntry | undefined): boolean {
	if (!entry) return false;
	return Date.now() - entry.exhaustedAt < entry.cooldownMs;
}

function remainingCooldown(entry: CooldownEntry | undefined): number {
	if (!entry) return 0;
	return Math.max(0, entry.cooldownMs - (Date.now() - entry.exhaustedAt));
}

function formatCooldown(ms: number): string {
	if (ms <= 0) return "";
	const secs = Math.ceil(ms / 1000);
	return secs < 60 ? `${secs}s` : `~${Math.ceil(secs / 60)}m`;
}

function nextRecoveryText(state: KeyState): string {
	const waits = Object.values(state.cooled).map((entry) => remainingCooldown(entry)).filter((ms) => ms > 0);
	if (waits.length === 0) return "";
	return `; next key available in ${formatCooldown(Math.min(...waits))}`;
}

function appendDebugLog(state: KeyState, ki: number, sid: string, et: ErrorType, msg: string, action: string): void {
	if (!state.debugLog) state.debugLog = [];
	state.debugLog.push({
		timestamp: Date.now(),
		keyIndex: ki,
		sessionId: sid.slice(0, 8),
		errorType: et,
		errorMessage: redactSensitive(msg).slice(0, 500),
		action,
	});
	if (state.debugLog.length > 50) state.debugLog = state.debugLog.slice(-50);
}

function redactSensitive(text: string): string {
	return text.replace(/\b(?:sk|tp|ak)-[A-Za-z0-9_-]{8,}\b/g, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`);
}

function maskKey(key: string): string {
	if (key.length <= 10) return "****";
	return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function cleanupStaleAssignments(state: KeyState, ttlMs: number): number {
	const now = Date.now();
	let cleaned = 0;
	for (const [outerKey, value] of Object.entries(state.assignments)) {
		// 嵌套新格式：{ [provider]: { [sid]: Assignment } }
		if (value && typeof value === "object" && !("keyIndex" in value) && !("since" in value)) {
			for (const [sid, assignment] of Object.entries(value as Record<string, Assignment>)) {
				if (assignment && now - assignment.since > ttlMs) {
					delete (value as Record<string, Assignment>)[sid];
					delete state.retryCounts?.[sid];
					cleaned++;
				}
			}
			continue;
		}
		// 老扁平格式：{ [sid]: Assignment }
		const assignment = value as Assignment;
		if (assignment && now - assignment.since > ttlMs) {
			delete state.assignments[outerKey];
			delete state.retryCounts?.[outerKey];
			cleaned++;
		}
	}
	return cleaned;
}

// ── 核心：分配 key 给 session ────────────────────────────────

/**
 * 从 provider 绑定的 session 子集（`state.assignments[provider]`）中取已分配的 keyIndex。
 * 兼容老格式：如果 assignments[provider] 不存在或为扁平结构，返回空。
 */
function getProviderAssignments(state: KeyState, provider: string): Record<string, Assignment> {
	const bucket = state.assignments[provider];
	if (bucket && typeof bucket === "object" && !Array.isArray(bucket)) {
		// 校验：值是 Assignment 形状才认
		const sample = Object.values(bucket)[0];
		if (!sample || typeof sample === "object" && "keyIndex" in sample && "since" in sample) {
			return bucket as Record<string, Assignment>;
		}
	}
	return {};
}

/**
 * 在某个 provider 的 key 子集中挑一个可用的。
 * 跳过已被该 provider 其他 session 占用的，跳过冷却的；已分配给该 session 自己的优先保留。
 * 返回该 provider 在 `keys` 数组中的原始 keyIndex（用于输出 key 本身），或 -1。
 */
function chooseAvailableKeyForProvider(state: KeyState, provider: string, providerKeyIndexes: number[], sessionId?: string): number {
	if (providerKeyIndexes.length === 0) return -1;
	const providerAssignments = getProviderAssignments(state, provider);
	const myAssignment = sessionId ? providerAssignments[sessionId] : undefined;
	if (myAssignment && !isCooled(state.cooled[String(myAssignment.keyIndex)])) return myAssignment.keyIndex;
	const assignedIndexes = new Set(Object.values(providerAssignments).map((a) => a.keyIndex));
	for (const idx of providerKeyIndexes) {
		if (!assignedIndexes.has(idx) && !isCooled(state.cooled[String(idx)])) return idx;
	}
	return -1;
}

function assignKeyToProviderSession(provider: string, sessionId: string): number {
	const keys = readKeys();
	const config = loadConfig();
	if (keys.length === 0) return -1;

	const groups = groupKeysByProvider(keys);
	const providerKeyIndexes = (groups[provider] ?? []).map((g) => g.index);
	if (providerKeyIndexes.length === 0) return -1;

	return updateState((state) => {
		cleanupStaleAssignments(state, config.assignmentTtlMs);
		// 初始化分桶
		if (!state.assignments[provider] || typeof (state.assignments as any)[provider] !== "object") {
			(state.assignments as Record<string, Record<string, Assignment>>)[provider] = {};
		}
		const providerAssignments = getProviderAssignments(state, provider);
		const existing = providerAssignments[sessionId];
		if (existing && !isCooled(state.cooled[String(existing.keyIndex)])) return existing.keyIndex;

		const keyIndex = chooseAvailableKeyForProvider(state, provider, providerKeyIndexes);
		if (keyIndex < 0) return -1;
		(state.assignments as Record<string, Record<string, Assignment>>)[provider][sessionId] = { keyIndex, since: Date.now() };
		return keyIndex;
	});
}

function releaseProviderSession(provider: string, sessionId: string): void {
	updateState((state) => {
		const bucket = (state.assignments as Record<string, Record<string, Assignment>>)[provider];
		if (bucket) delete bucket[sessionId];
		delete state.retryCounts?.[sessionId];
	});
}

function switchProviderSessionKey(provider: string, sessionId: string, reason: ErrorType, debugMessage: string, debugEnabled: boolean): { oldKeyIndex: number; newKeyIndex: number } {
	const keys = readKeys();
	const config = loadConfig();
	const groups = groupKeysByProvider(keys);
	const providerKeyIndexes = (groups[provider] ?? []).map((g) => g.index);

	return updateState((state) => {
		// 初始化分桶
		if (!state.assignments[provider] || typeof (state.assignments as any)[provider] !== "object") {
			(state.assignments as Record<string, Record<string, Assignment>>)[provider] = {};
		}
		const providerAssignments = getProviderAssignments(state, provider);
		const assignment = providerAssignments[sessionId];
		const oldKeyIndex = assignment?.keyIndex ?? -1;
		if (assignment) {
			const cooldownMs = reason === "capacity" ? config.cooldownMs.capacity : reason === "quota" ? config.cooldownMs.quota : config.cooldownMs.network;
			if (cooldownMs > 0) state.cooled[String(assignment.keyIndex)] = { exhaustedAt: Date.now(), cooldownMs, reason };
			delete providerAssignments[sessionId];
		}

		cleanupStaleAssignments(state, config.assignmentTtlMs);
		const newKeyIndex = chooseAvailableKeyForProvider(state, provider, providerKeyIndexes);
		if (newKeyIndex >= 0) {
			(state.assignments as Record<string, Record<string, Assignment>>)[provider][sessionId] = { keyIndex: newKeyIndex, since: Date.now() };
		}

		state.retryCounts ??= {};
		state.retryCounts[sessionId] = (state.retryCounts[sessionId] ?? state.retryCount ?? 0) + 1;
		state.retryCount = state.retryCounts[sessionId];
		if (debugEnabled) appendDebugLog(state, oldKeyIndex, sessionId, reason, debugMessage, `switch→#${newKeyIndex + 1}`);
		return { oldKeyIndex, newKeyIndex };
	});
}

function getRetryCount(state: KeyState, sessionId: string): number {
	return state.retryCounts?.[sessionId] ?? state.retryCount ?? 0;
}

function resetRetryCount(sessionId: string): void {
	updateState((state) => {
		if (state.retryCounts?.[sessionId]) delete state.retryCounts[sessionId];
		state.retryCount = 0;
	});
}

// ── 自动配置 models.json ──────────────────────────────────

function autoConfigureModelsJson(): void {
	try {
		const keys = readKeys();
		if (keys.length === 0) return;

		// 收集所有出现过的 provider（去重）
		const providers = new Set<string>();
		for (const k of keys) {
			if (k.provider && k.provider.trim()) providers.add(k.provider);
		}
		if (providers.size === 0) return;

		let models: Record<string, any> = {};
		if (existsSync(MODELS_FILE)) {
			try {
				models = JSON.parse(readFileSync(MODELS_FILE, "utf-8"));
			} catch {
				return;
			}
			const backup = `${MODELS_FILE}.bak-key-pool`;
			if (!existsSync(backup)) copyFileSync(MODELS_FILE, backup);
		}

		if (!models.providers || typeof models.providers !== "object") models.providers = {};
		for (const provider of providers) {
			models.providers[provider] ??= {};
			models.providers[provider].apiKey = `!bash ${shellQuote(SCRIPT_FILE)}`;
		}
		writeFileSync(MODELS_FILE, JSON.stringify(models, null, 2), { encoding: "utf-8", mode: 0o600 });
		secureFile(MODELS_FILE, 0o600);
	} catch { /* 不阻塞加载 */ }
}

// ── Extension 入口 ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	if (!existsSync(AGENT_DIR)) mkdirSync(AGENT_DIR, { recursive: true });
	if (!existsSync(KEYS_FILE) || readFileSync(KEYS_FILE, "utf-8").trim() === "") {
		writeFileSync(KEYS_FILE, JSON.stringify({ keys: [{ key: "", provider: "", label: "key-1" }] }, null, 2), { encoding: "utf-8", mode: 0o600 });
	}
	if (!existsSync(CONFIG_FILE)) writeConfig(DEFAULT_CONFIG);
	secureFile(KEYS_FILE, 0o600);
	migrateConfig();
	deployGetCurrentKeyScript();
	autoConfigureModelsJson();

	let currentSessionId: string | null = null;
	let retryScheduled = false;

	function retryLastUserMessage(ctx: ExtensionContext): void {
		if (retryScheduled) return;
		const branch = ctx.sessionManager.getBranch();
		const lastUser = branch.slice().reverse().find((e: any) => e.type === "message" && e.message?.role === "user");
		if (!lastUser?.message?.content) return;
		retryScheduled = true;
		ctx.ui.notify("🔄 Switching key and retrying...", "warning");
		pi.sendUserMessage(lastUser.message.content as any, { deliverAs: "followUp" });
		setTimeout(() => { retryScheduled = false; }, 1_000);
	}

	pi.on("session_start", (_event, ctx) => {
		const keys = readKeys();
		if (keys.length === 0) {
			ctx.ui.notify("key-pool: no non-empty keys configured", "error");
		}

		currentSessionId = randomUUID();
		process.env.PI_KEY_POOL_SESSION_ID = currentSessionId;
		writeSessionId(currentSessionId);
		// 不预先分配 key：等首次 model_select 触发绑定，避免 session 被错误预绑定到非 managed provider。
	});

	pi.on("model_select", (event, _ctx) => {
		if (!currentSessionId) return;
		const provider = event.model?.provider;
		if (!provider || !isManagedProvider(provider)) {
			// 非 managed provider：清除 provider env，让 bash 走 fallback（取 keys.json 第一个带 provider 的 key）
			delete process.env.PI_KEY_POOL_PROVIDER;
			return;
		}
		process.env.PI_KEY_POOL_PROVIDER = provider;
		// 按需分配一个 key 给该 session
		assignKeyToProviderSession(provider, currentSessionId);
	});

	pi.on("session_shutdown", () => {
		if (!currentSessionId) return;
		// 释放该 session 在所有 provider 下的绑定
		const state = loadState();
		for (const provider of Object.keys(state.assignments)) {
			releaseProviderSession(provider, currentSessionId);
		}
		if (process.env.PI_KEY_POOL_SESSION_ID === currentSessionId) delete process.env.PI_KEY_POOL_SESSION_ID;
		delete process.env.PI_KEY_POOL_PROVIDER;
		removeSessionFile(currentSessionId);
		currentSessionId = null;
	});

	pi.on("turn_end", (event, ctx) => {
		if (!currentSessionId) return;
		// 关键：只有当前 provider 被 key-pool 管理时才介入；非 managed provider (如 zai/GLM、openai-codex) 的错误不接管。
		const provider = ctx.model?.provider;
		if (!provider || !isManagedProvider(provider)) return;

		const msg = event.message;

		if (msg?.role === "assistant" && msg.stopReason !== "error") {
			const state = loadState();
			if (getRetryCount(state, currentSessionId) > 0) resetRetryCount(currentSessionId);
			return;
		}

		if (!msg || msg.role !== "assistant" || msg.stopReason !== "error") return;
		const cfg = loadConfig();
		const state = loadState();
		const retryCount = getRetryCount(state, currentSessionId);
		const errMsg = msg.errorMessage ?? "unknown";

		const classification = classifyError(errMsg);
		if (!classification.shouldSwitch) {
			if (classification.type === "network") ctx.ui.notify(`⚡ key-pool: network error (not switching)${cfg.debug ? `: ${redactSensitive(errMsg).slice(0, 80)}` : ""}`, "info");
			return;
		}

		const result = switchProviderSessionKey(provider, currentSessionId, classification.type, errMsg, cfg.debug);
		const attempt = retryCount + 1;
		const errorPreview = redactSensitive(errMsg).slice(0, 80);

		if (result.newKeyIndex < 0) {
			const recovery = nextRecoveryText(loadState());
			ctx.ui.notify(`❌ key-pool: all keys are cooling${recovery}; auto retry stopped`, "error");
			resetRetryCount(currentSessionId);
			return;
		}

		pi.sendMessage({
			customType: "key-pool",
			content: `⚠️ #${result.oldKeyIndex + 1} [${classification.type}] ${errorPreview}\n   → #${result.newKeyIndex + 1}`,
			display: true,
		}, { deliverAs: "followUp" });

		if (attempt > cfg.maxRetries) {
			ctx.ui.notify(`❌ key-pool: max retries (${cfg.maxRetries}) reached; auto retry stopped`, "error");
			resetRetryCount(currentSessionId);
			return;
		}

		if (classification.type === "quota" && retryCount > 0) {
			ctx.ui.notify(`⏸️ key-pool: consecutive 429/quota errors; auto retry stopped. Current session switched to key #${result.newKeyIndex + 1}`, "warning");
			resetRetryCount(currentSessionId);
			return;
		}

		retryLastUserMessage(ctx);
	});

	pi.registerCommand("pool-status", {
		description: "查看 key pool 状态",
		handler: async (_args, ctx) => {
			const keys = readKeys();
			const state = loadState();
			const cfg = loadConfig();
			if (keys.length === 0) { ctx.ui.notify("key-pool: keys.json has no non-empty keys", "error"); return; }

			// 计算总 session 数（按 provider 分桶后的）
			let totalSessions = 0;
			for (const value of Object.values(state.assignments)) {
				if (value && typeof value === "object" && !("keyIndex" in value)) {
					totalSessions += Object.keys(value).length;
				} else {
					// 老扁平格式当作 1 个 session
					totalSessions += 1;
				}
			}
			const activeCooled = Object.values(state.cooled).filter((e) => isCooled(e)).length;
			const lines: string[] = [`Key Pool: ${keys.length} keys | ${totalSessions} sessions | ${activeCooled} cooling`, ""];

			if (currentSessionId) {
				const provider = process.env.PI_KEY_POOL_PROVIDER;
				const providerAssignments = provider ? getProviderAssignments(state, provider) : {};
				const assignment = providerAssignments[currentSessionId];
				if (assignment) {
					const keyEntry = keys[assignment.keyIndex];
					const label = keyEntry?.label ? ` (${keyEntry.label})` : "";
					lines.push(`Current session: ${currentSessionId.slice(0, 8)}... → key #${assignment.keyIndex + 1}${label}${provider ? ` [${provider}]` : ""}`);
				} else if (provider) {
					lines.push(`Current session: ${currentSessionId.slice(0, 8)}... [${provider}] (no key assigned yet)`);
				}
			}
			lines.push("");

			// 按 provider 分组展示
			const groups = groupKeysByProvider(keys);
			const sortedProviders = Object.keys(groups).sort();
			if (sortedProviders.length === 0) {
				// 兜底：老 keys 没有 provider
				for (let i = 0; i < keys.length; i++) {
					const ke = keys[i];
					const label = ke.label ? `(${ke.label})` : "";
					lines.push(`  #${i + 1}  ${maskKey(ke.key)}${label}`);
				}
			} else {
				for (const provider of sortedProviders) {
					const groupItems = groups[provider];
					const providerAssignments = getProviderAssignments(state, provider);
					lines.push(`[${provider}]`);
					for (const { entry: ke, index: i } of groupItems) {
						const label = ke.label ? `(${ke.label})` : "";
						const parts: string[] = [];
						const sessionsUsing = Object.entries(providerAssignments).filter(([, a]) => a.keyIndex === i).map(([sid]) => `${sid.slice(0, 8)}...`);
						if (sessionsUsing.length > 0) parts.push(`sessions: ${sessionsUsing.join(", ")}`);
						const cd = state.cooled[String(i)];
						if (cd && isCooled(cd)) parts.push(`❄️ ${cd.reason} ${formatCooldown(remainingCooldown(cd))}`);
						else if (cd) parts.push(`✅ ${cd.reason} (recovered)`);
						lines.push(`  #${i + 1}  ${maskKey(ke.key)}${label}${parts.length ? "  — " + parts.join(", ") : ""}`);
					}
				}
			}

			lines.push("");
			lines.push(`Retry: ${currentSessionId ? getRetryCount(state, currentSessionId) : 0}/${cfg.maxRetries} | Debug: ${cfg.debug ? "ON" : "OFF"}`);
			lines.push(`Cooldowns: capacity=${cfg.cooldownMs.capacity / 1000}s, quota=${cfg.cooldownMs.quota / 1000}s, network=${cfg.cooldownMs.network / 1000}s`);
			lines.push(`Assignment TTL: ${cfg.assignmentTtlMs / 60000}min`);

			if (cfg.debug && state.debugLog?.length) {
				lines.push("", "--- Debug Log ---");
				for (const e of state.debugLog.slice(-10)) lines.push(`  [${new Date(e.timestamp).toLocaleTimeString()}] #${e.keyIndex + 1} (${e.sessionId}...) [${e.errorType}] ${e.action}: ${e.errorMessage.slice(0, 80)}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("pool-reset", {
		description: "清除所有冷却标记",
		handler: async (_args, ctx) => {
			const count = updateState((state) => {
				const current = Object.keys(state.cooled).length;
				state.cooled = {};
				state.retryCount = 0;
				state.retryCounts = {};
				state.debugLog = [];
				return current;
			});
			ctx.ui.notify(`Pool reset: ${count} cooldowns cleared`, "info");
		},
	});

	pi.registerCommand("pool-clean", {
		description: "清理超时的 session 绑定",
		handler: async (_args, ctx) => {
			const cfg = loadConfig();
			const result = updateState((state) => {
				const before = Object.keys(state.assignments).length;
				const cleaned = cleanupStaleAssignments(state, cfg.assignmentTtlMs);
				return { before, after: Object.keys(state.assignments).length, cleaned };
			});
			ctx.ui.notify(`Cleaned ${result.cleaned} stale assignments (${result.before} → ${result.after})`, "info");
		},
	});
}

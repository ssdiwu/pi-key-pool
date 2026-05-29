/**
 * pi-key-pool — API Key Pool Manager for pi
 *
 * 核心能力：
 *   1. Session 绑定   — 每个 session 独占一个 key，完全隔离
 *   2. 冷却恢复       — 失败 key 带时间戳标记，到期自动恢复
 *   3. 自动重试       — 切换 key 后自动重发上一条用户消息（用户无感）
 *   4. 错误分类       — capacity / quota / network 三类独立策略
 *   5. 僵尸清理       — 启动时清理超时的 assignments
 *
 * 架构：
 *   models.json apiKey = "!bash get-current-key.sh"
 *     → 每次请求执行脚本 → 读 .current-session + .key-state → 输出当前 key
 *   extension 管理 .key-state（assignments / cooldown）
 *
 * 运行时数据（~/.pi/agent/key-pool/）：
 *   keys.json           — key 池
 *   pool-config.json    — 配置
 *   .key-state          — 状态（extension 维护）
 *   .current-session    — 当前 sessionId（供 get-current-key.sh 读取）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── 路径常量 ────────────────────────────────────────────────

const HOME = process.env.HOME || "";
const AGENT_DIR = join(HOME, ".pi", "agent", "key-pool");
const KEYS_FILE = join(AGENT_DIR, "keys.json");
const STATE_FILE = join(AGENT_DIR, ".key-state");
const CONFIG_FILE = join(AGENT_DIR, "pool-config.json");
const SESSION_FILE = join(AGENT_DIR, ".current-session");

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
	assignments: Record<string, Assignment>;
	cooled: Record<string, CooldownEntry>;
	retryCount: number;
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

// ── 默认配置 ─────────────────────────────────────────────────

const DEFAULT_CONFIG: PoolConfig = {
	cooldownMs: { capacity: 30_000, quota: 300_000, network: 0 },
	maxRetries: 3,
	assignmentTtlMs: 3600_000, // 1 小时
	debug: false,
};

// ── 文件读写 ─────────────────────────────────────────────────

function loadConfig(): PoolConfig {
	try {
		if (!existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
		const raw = readFileSync(CONFIG_FILE, "utf-8").trim();
		if (!raw) return DEFAULT_CONFIG;
		return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
	} catch { return DEFAULT_CONFIG; }
}

/**
 * 检测并补充缺失的配置字段
 * 保留用户已有的值，只添加新字段的默认值
 */
function migrateConfig(): void {
	try {
		if (!existsSync(CONFIG_FILE)) return;
		const raw = readFileSync(CONFIG_FILE, "utf-8").trim();
		if (!raw) return;
		
		const existing = JSON.parse(raw);
		const merged = { ...DEFAULT_CONFIG, ...existing };
		
		// 检测是否有新增字段
		const hasNewFields = Object.keys(DEFAULT_CONFIG).some(
			(key) => !(key in existing)
		);
		
		if (hasNewFields) {
			writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
		}
	} catch {
		// 静默失败，不影响启动
	}
}

function loadState(): KeyState {
	try {
		if (!existsSync(STATE_FILE)) return freshState();
		const raw = readFileSync(STATE_FILE, "utf-8").trim();
		if (!raw) return freshState();
		const parsed = JSON.parse(raw);
		
		// 兼容旧格式：如果没有 assignments，从 index 迁移
		if (!parsed.assignments && typeof parsed.index === "number") {
			return {
				assignments: {},
				cooled: parsed.cooled || {},
				retryCount: parsed.retryCount || 0,
				debugLog: parsed.debugLog,
			};
		}
		
		return { ...freshState(), ...parsed };
	} catch { return freshState(); }
}

function saveState(state: KeyState) {
	writeFileSync(STATE_FILE, JSON.stringify(state), "utf-8");
}

function freshState(): KeyState {
	return { assignments: {}, cooled: {}, retryCount: 0 };
}

function readKeys(): KeyEntry[] {
	try {
		if (!existsSync(KEYS_FILE)) return [];
		const raw = readFileSync(KEYS_FILE, "utf-8").trim();
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		const arr = Array.isArray(parsed) ? parsed : parsed.keys ?? [];
		return arr.filter((e: any) => e && typeof e.key === "string");
	} catch { return []; }
}

function readSessionId(): string | null {
	try {
		if (!existsSync(SESSION_FILE)) return null;
		return readFileSync(SESSION_FILE, "utf-8").trim() || null;
	} catch { return null; }
}

function writeSessionId(sessionId: string) {
	writeFileSync(SESSION_FILE, sessionId, "utf-8");
}

function removeSessionFile() {
	try {
		if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE);
	} catch { /* ignore */ }
}

// ── 错误分类 ─────────────────────────────────────────────────

function classifyError(msg?: string): ErrorClassification {
	if (!msg) return { type: "unknown", shouldSwitch: false };
	const lower = msg.toLowerCase();

	const NETWORK_PATTERNS = [
		/internal network failure/i, /api_error/i, /network failure/i,
		/connection reset/i, /connection refused/i, /etimedout/i,
		/econnreset/i, /econnrefused/i, /socket hang up/i, /fetch failed/i,
	];
	if (NETWORK_PATTERNS.some((p) => p.test(lower)))
		return { type: "network", shouldSwitch: false };

	const CAPACITY_PATTERNS = [/capacity/i, /no capacity/i, /engine overloaded/i, /overloaded/i, /status_code:? *529/i];
	if (CAPACITY_PATTERNS.some((p) => p.test(lower)))
		return { type: "capacity", shouldSwitch: true };

	const QUOTA_PATTERNS = [/status_code:? *429/i, /rate.?limit/i, /too many requests/i, /insufficient quota/i];
	if (QUOTA_PATTERNS.some((p) => p.test(lower)))
		return { type: "quota", shouldSwitch: true };

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

// ── Debug 日志 ───────────────────────────────────────────────

function appendDebugLog(state: KeyState, ki: number, sid: string, et: ErrorType, msg: string, action: string): void {
	if (!state.debugLog) state.debugLog = [];
	state.debugLog.push({ 
		timestamp: Date.now(), 
		keyIndex: ki, 
		sessionId: sid.slice(0, 8), 
		errorType: et, 
		errorMessage: msg.slice(0, 500), 
		action 
	});
	if (state.debugLog.length > 50) state.debugLog = state.debugLog.slice(-50);
}

// ── 僵尸清理 ─────────────────────────────────────────────────

function cleanupStaleAssignments(state: KeyState, ttlMs: number): number {
	const now = Date.now();
	let cleaned = 0;
	for (const [sid, assignment] of Object.entries(state.assignments)) {
		if (now - assignment.since > ttlMs) {
			delete state.assignments[sid];
			cleaned++;
		}
	}
	return cleaned;
}

// ── 核心：分配 key 给 session ────────────────────────────────

function assignKeyToSession(sessionId: string): number {
	const keys = readKeys();
	const state = loadState();
	const config = loadConfig();
	const total = keys.length;
	if (total === 0) return -1;

	// 清理僵尸 assignments
	const cleaned = cleanupStaleAssignments(state, config.assignmentTtlMs);
	if (cleaned > 0) {
		saveState(state);
	}

	// 已分配的 key indexes
	const assignedIndexes = new Set(
		Object.values(state.assignments).map((a) => a.keyIndex)
	);

	// 找到未被占用且未冷却的 key
	for (let offset = 0; offset < total; offset++) {
		const candidate = offset % total;
		if (assignedIndexes.has(candidate)) continue;
		if (isCooled(state.cooled[String(candidate)])) continue;
		
		// 找到空闲 key，分配
		state.assignments[sessionId] = { keyIndex: candidate, since: Date.now() };
		saveState(state);
		return candidate;
	}

	// 所有 key 都被占用或冷却，找最早释放的
	let earliestIdx = 0;
	let earliestTime = Infinity;
	for (let i = 0; i < total; i++) {
		if (assignedIndexes.has(i)) {
			// 被占用，看什么时候分配的
			const assignment = Object.values(state.assignments).find((a) => a.keyIndex === i);
			if (assignment && assignment.since < earliestTime) {
				earliestTime = assignment.since;
				earliestIdx = i;
			}
		} else {
			// 冷却中，看什么时候恢复
			const cd = state.cooled[String(i)];
			const recoverAt = cd ? cd.exhaustedAt + cd.cooldownMs : 0;
			if (recoverAt < earliestTime) {
				earliestTime = recoverAt;
				earliestIdx = i;
			}
		}
	}

	// 强制分配（可能会让另一个 session 失效，但避免死锁）
	state.assignments[sessionId] = { keyIndex: earliestIdx, since: Date.now() };
	saveState(state);
	return earliestIdx;
}

function releaseSessionAssignment(sessionId: string): void {
	const state = loadState();
	if (state.assignments[sessionId]) {
		delete state.assignments[sessionId];
		saveState(state);
	}
}

function markSessionKeyCooled(sessionId: string, reason: ErrorType): void {
	const state = loadState();
	const config = loadConfig();
	const assignment = state.assignments[sessionId];
	if (!assignment) return;

	const cd =
		reason === "capacity" ? config.cooldownMs.capacity
		: reason === "quota" ? config.cooldownMs.quota
		: config.cooldownMs.network;
	if (cd <= 0 && reason === "network") return;

	state.cooled[String(assignment.keyIndex)] = { exhaustedAt: Date.now(), cooldownMs: cd, reason };
	saveState(state);
}

// ── 自动配置 models.json ──────────────────────────────────

const MODELS_FILE = join(HOME, ".pi", "models.json");

function autoConfigureModelsJson(): void {
	try {
		const keys = readKeys();
		if (keys.length === 0) return;

		const targetProvider = keys[0].provider || "";
		if (!targetProvider) return;

		let models: Record<string, any> = {};
		if (existsSync(MODELS_FILE)) {
			try { models = JSON.parse(readFileSync(MODELS_FILE, "utf-8")); } catch {}
		}

		if (!models.providers) models.providers = {};

		const scriptPath = join(AGENT_DIR, "get-current-key.sh");
		if (!models.providers[targetProvider]) {
			models.providers[targetProvider] = {};
		}
		models.providers[targetProvider].apiKey = `!bash ${scriptPath}`;

		writeFileSync(MODELS_FILE, JSON.stringify(models, null, 2), "utf-8");
	} catch {
		// 不阻塞加载
	}
}

// ── Extension 入口 ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	// ── 首次加载初始化 ─────────────────────────────────
	if (!existsSync(AGENT_DIR)) mkdirSync(AGENT_DIR, { recursive: true });
	if (!existsSync(KEYS_FILE) || readFileSync(KEYS_FILE, "utf-8").trim() === "")
		writeFileSync(KEYS_FILE, JSON.stringify({ keys: [{ key: "", label: "key-1" }] }, null, 2), "utf-8");
	if (!existsSync(CONFIG_FILE))
		writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
	
	// 检测并补充缺失的配置字段（版本升级兼容）
	migrateConfig();

	autoConfigureModelsJson();

	// ── 当前 session ID（闭包内）────────────────────────
	let currentSessionId: string | null = null;

	// ── 重试状态（闭包内）────────────────────────────────
	let isRetrying = false;

	function retryLastUserMessage(ctx: ExtensionContext): void {
		if (isRetrying) return;
		const branch = ctx.sessionManager.getBranch();
		const lastUser = branch.slice().reverse().find((e: any) => e.type === "message" && e.message?.role === "user");
		if (!lastUser?.message?.content) return;
		isRetrying = true;
		ctx.ui.notify("🔄 Switching key and retrying...", "warning");
		pi.sendMessage({
			customType: "key-pool",
			content: `[auto-retry] ${typeof lastUser.message.content === "string" ? lastUser.message.content : JSON.stringify(lastUser.message.content)}`,
			display: false,
		}, { deliverAs: "steer" });
		setTimeout(() => { isRetrying = false; }, 5000);
	}

	// ════════════════════════════════════════════════════════════
	// 策略 1：Session 绑定
	// ════════════════════════════════════════════════════════════
	pi.on("session_start", (_event, ctx) => {
		const keys = readKeys();
		if (keys.length === 0) {
			ctx.ui.notify("key-pool: no keys configured", "error");
			return;
		}

		// 生成 session ID
		currentSessionId = randomUUID();
		writeSessionId(currentSessionId);

		// 分配 key
		const keyIndex = assignKeyToSession(currentSessionId);
		const state = loadState();
		const assignment = state.assignments[currentSessionId];

		if (keyIndex >= 0 && assignment) {
			const label = keys[keyIndex].label ? ` (${keys[keyIndex].label})` : "";
			ctx.ui.notify(`key-pool: session ${currentSessionId.slice(0, 8)}... → key #${keyIndex + 1}${label}`, "info");
		} else {
			ctx.ui.notify("key-pool: failed to assign key", "error");
		}
	});

	// ════════════════════════════════════════════════════════════
	// 策略 2：Session 清理
	// ════════════════════════════════════════════════════════════
	pi.on("session_shutdown", () => {
		if (currentSessionId) {
			releaseSessionAssignment(currentSessionId);
			currentSessionId = null;
		}
		removeSessionFile();
	});

	// ════════════════════════════════════════════════════════════
	// 策略 3：错误检测 + 冷却 + 重试
	// ════════════════════════════════════════════════════════════
	pi.on("turn_end", (event, ctx) => {
		if (isRetrying) return;
		if (!currentSessionId) return;

		const msg = event.message;
		if (!msg || msg.role !== "assistant" || msg.stopReason !== "error") return;

		const cfg = loadConfig();
		const state = loadState();

		if (state.retryCount >= cfg.maxRetries) {
			const errMsg = msg.errorMessage ?? "unknown";
			ctx.ui.notify(`❌ key-pool: max retries (${cfg.maxRetries}) reached.${cfg.debug ? ` ${errMsg.slice(0, 120)}` : ""}`, "error");
			if (cfg.debug) { appendDebugLog(state, state.assignments[currentSessionId]?.keyIndex ?? 0, currentSessionId, "unknown", errMsg, "max-retries"); saveState(state); }
			state.retryCount = 0; saveState(state); return;
		}

		const classification = classifyError(msg.errorMessage);
		if (!classification.shouldSwitch) {
			if (classification.type === "network")
				ctx.ui.notify(`⚡ key-pool: network error (not switching)${cfg.debug ? `: ${(msg.errorMessage ?? "").slice(0, 80)}` : ""}`, "info");
			return;
		}

		const oldKeyIndex = state.assignments[currentSessionId]?.keyIndex ?? 0;
		markSessionKeyCooled(currentSessionId, classification.type);

		// 释放当前 session 的分配，重新分配
		releaseSessionAssignment(currentSessionId);
		const newKeyIndex = assignKeyToSession(currentSessionId);

		const updatedState = loadState();
		updatedState.retryCount++;
		if (cfg.debug) appendDebugLog(updatedState, oldKeyIndex, currentSessionId, classification.type, msg.errorMessage ?? "", `switch→#${newKeyIndex + 1}`);
		saveState(updatedState);

		const errorPreview = (msg.errorMessage ?? "").slice(0, 80);
		pi.sendMessage({
			customType: "key-pool",
			content: `⚠️ #${oldKeyIndex + 1} [${classification.type}] ${errorPreview}\n   → #${newKeyIndex + 1}`,
			display: true,
		}, { deliverAs: "followUp" });

		retryLastUserMessage(ctx);
	});

	// ════════════════════════════════════════════════════════════
	// 命令：查看池状态
	// ════════════════════════════════════════════════════════════
	pi.registerCommand("pool-status", {
		description: "查看 key pool 状态",
		handler: async (_args, ctx) => {
			const keys = readKeys();
			const state = loadState();
			const cfg = loadConfig();
			if (keys.length === 0) { ctx.ui.notify("key-pool: keys.json is empty", "error"); return; }

			const activeCooled = Object.values(state.cooled).filter((e) => isCooled(e)).length;
			const activeAssignments = Object.keys(state.assignments).length;
			const lines: string[] = [];

			lines.push(`Key Pool: ${keys.length} keys | ${activeAssignments} sessions | ${activeCooled} cooling`);
			lines.push("");

			// 显示当前 session
			if (currentSessionId) {
				const assignment = state.assignments[currentSessionId];
				if (assignment) {
					const label = keys[assignment.keyIndex].label ? ` (${keys[assignment.keyIndex].label})` : "";
					lines.push(`Current session: ${currentSessionId.slice(0, 8)}... → key #${assignment.keyIndex + 1}${label}`);
				}
			}
			lines.push("");

			// 显示所有 keys
			for (let i = 0; i < keys.length; i++) {
				const ke = keys[i];
				const masked = ke.key.slice(0, 14) + "...";
				const label = ke.label ? `(${ke.label})` : "";
				const parts: string[] = [];

				// 哪些 session 在用这个 key
				const sessionsUsing = Object.entries(state.assignments)
					.filter(([, a]) => a.keyIndex === i)
					.map(([sid]) => sid.slice(0, 8) + "...");
				if (sessionsUsing.length > 0) parts.push(`sessions: ${sessionsUsing.join(", ")}`);

				const cd = state.cooled[String(i)];
				if (cd && isCooled(cd)) parts.push(`❄️ ${cd.reason} ${formatCooldown(remainingCooldown(cd))}`);
				else if (cd) parts.push(`✅ ${cd.reason} (recovered)`);

				lines.push(`  #${i + 1}  ${masked}${label}${parts.length ? "  — " + parts.join(", ") : ""}`);
			}

			lines.push("");
			lines.push(`Retry: ${state.retryCount}/${cfg.maxRetries} | Debug: ${cfg.debug ? "ON" : "OFF"}`);
			lines.push(`Cooldowns: capacity=${cfg.cooldownMs.capacity / 1000}s, quota=${cfg.cooldownMs.quota / 1000}s`);
			lines.push(`Assignment TTL: ${cfg.assignmentTtlMs / 60000}min`);

			if (cfg.debug && state.debugLog?.length) {
				lines.push("", "--- Debug Log ---");
				for (const e of state.debugLog.slice(-10))
					lines.push(`  [${new Date(e.timestamp).toLocaleTimeString()}] #${e.keyIndex + 1} (${e.sessionId}...) [${e.errorType}] ${e.action}: ${e.errorMessage.slice(0, 80)}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ════════════════════════════════════════════════════════════
	// 命令：清除冷却标记
	// ════════════════════════════════════════════════════════════
	pi.registerCommand("pool-reset", {
		description: "清除所有冷却标记",
		handler: async (_args, ctx) => {
			const state = loadState();
			const count = Object.keys(state.cooled).length;
			state.cooled = {};
			state.retryCount = 0;
			if (state.debugLog) state.debugLog = [];
			saveState(state);
			ctx.ui.notify(`Pool reset: ${count} cooldowns cleared`, "info");
		},
	});

	// ════════════════════════════════════════════════════════════
	// 命令：清理僵尸 assignments
	// ════════════════════════════════════════════════════════════
	pi.registerCommand("pool-clean", {
		description: "清理超时的 session 绑定",
		handler: async (_args, ctx) => {
			const state = loadState();
			const cfg = loadConfig();
			const before = Object.keys(state.assignments).length;
			const cleaned = cleanupStaleAssignments(state, cfg.assignmentTtlMs);
			saveState(state);
			ctx.ui.notify(`Cleaned ${cleaned} stale assignments (${before} → ${Object.keys(state.assignments).length})`, "info");
		},
	});
}

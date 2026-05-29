/**
 * pi-key-pool — API Key Pool Manager for pi
 *
 * 核心能力：
 *   1. 新会话轮换   — session_start 时自动切换到下一个可用 key（保缓存）
 *   2. 冷却恢复     — 失败 key 带时间戳标记，到期自动恢复
 *   3. 自动重试     — 切换 key 后自动重发上一条用户消息（用户无感）
 *   4. 错误分类     — capacity / quota / network 三类独立策略
 *   5. 调试日志     — debug 模式下保留异常详情，方便排查
 *
 * 工作原理：
 *   轮换时直接写入 ~/.pi/agent/auth.json 中对应 provider 的 key 字段
 *   不需要 shell 脚本，不需要改 models.json
 *
 * 文件结构（~/.pi/agent/key-pool/）：
 *   keys.json         — key 池（JSON 格式，支持 label）
 *   pool-config.json  — 配置（冷却时间、重试次数、targetProvider、debug）
 *   .key-state        — 运行时状态（自动维护）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 路径常量 ────────────────────────────────────────────────

const HOME = process.env.HOME || "";
const AGENT_DIR = join(HOME, ".pi", "agent", "key-pool");
const KEYS_FILE = join(AGENT_DIR, "keys.json");
const STATE_FILE = join(AGENT_DIR, ".key-state");
const CONFIG_FILE = join(AGENT_DIR, "pool-config.json");
const AUTH_FILE = join(HOME, ".pi", "agent", "auth.json");

// ── 类型定义 ─────────────────────────────────────────────────

interface CooldownEntry {
	exhaustedAt: number;
	cooldownMs: number;
	reason: ErrorType;
}

interface KeyState {
	index: number;
	cooled: Record<string, CooldownEntry>;
	retryCount: number;
	debugLog?: DebugEntry[];
}

interface DebugEntry {
	timestamp: number;
	keyIndex: number;
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
	label?: string;
}

interface PoolConfig {
	/** auth.json 中要操作的 provider 名称，如 "xiaomi-token-plan-cn" */
	targetProvider: string;
	cooldownMs: {
		capacity: number;
		quota: number;
		network: number;
	};
	maxRetries: number;
	retryOnSessionStart: boolean;
	debug: boolean;
}

// ── 默认配置 ─────────────────────────────────────────────────

const DEFAULT_CONFIG: PoolConfig = {
	targetProvider: "",
	cooldownMs: {
		capacity: 30_000,
		quota: 300_000,
		network: 0,
	},
	maxRetries: 3,
	retryOnSessionStart: true,
	debug: false,
};

// ── 文件读写 ─────────────────────────────────────────────────

function loadConfig(): PoolConfig {
	try {
		if (!existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
		const raw = readFileSync(CONFIG_FILE, "utf-8").trim();
		if (!raw) return DEFAULT_CONFIG;
		return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
	} catch {
		return DEFAULT_CONFIG;
	}
}

function loadState(): KeyState {
	try {
		if (!existsSync(STATE_FILE)) return freshState();
		const raw = readFileSync(STATE_FILE, "utf-8").trim();
		if (!raw) return freshState();
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed.failed)) {
			return {
				index: parsed.index ?? 0,
				cooled: Object.fromEntries(
					parsed.failed.map((i: number) => [
						String(i),
						{ exhaustedAt: Date.now(), cooldownMs: loadConfig().cooldownMs.quota, reason: "quota" as ErrorType },
					]),
				),
				retryCount: 0,
			};
		}
		return { ...freshState(), ...parsed };
	} catch {
		return freshState();
	}
}

function saveState(state: KeyState) {
	writeFileSync(STATE_FILE, JSON.stringify(state), "utf-8");
}

function freshState(): KeyState {
	return { index: 0, cooled: {}, retryCount: 0 };
}

function readKeys(): KeyEntry[] {
	try {
		if (!existsSync(KEYS_FILE)) return [];
		const raw = readFileSync(KEYS_FILE, "utf-8").trim();
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		const arr = Array.isArray(parsed) ? parsed : parsed.keys ?? [];
		return arr.filter((e: any) => e && typeof e.key === "string");
	} catch {
		return [];
	}
}

// ── 核心：将当前 key 写入 auth.json ──────────────────────────

/**
 * 将池中当前活跃的 key 写入 auth.json 的 targetProvider.key
 * 这是替代 shell 脚本的核心机制：直接操作 pi 的认证文件
 */
function syncKeyToAuth(): void {
	const config = loadConfig();
	if (!config.targetProvider) return;

	const keys = readKeys();
	const state = loadState();
	if (keys.length === 0 || state.index >= keys.length) return;

	const newKey = keys[state.index].key;
	if (!newKey) return;

	try {
		let auth: Record<string, any> = {};
		if (existsSync(AUTH_FILE)) {
			auth = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
		}
		if (!auth[config.targetProvider]) {
			auth[config.targetProvider] = { type: "api_key", key: "" };
		}
		auth[config.targetProvider].key = newKey;
		writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), "utf-8");
	} catch {
		// auth.json 写入失败 — 不阻塞主流程
	}
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
	if (NETWORK_PATTERNS.some((p) => p.test(lower))) {
		return { type: "network", shouldSwitch: false };
	}

	const CAPACITY_PATTERNS = [
		/capacity/i, /no capacity/i, /engine overloaded/i,
		/overloaded/i, /status_code:? *529/i,
	];
	if (CAPACITY_PATTERNS.some((p) => p.test(lower))) {
		return { type: "capacity", shouldSwitch: true };
	}

	const QUOTA_PATTERNS = [
		/status_code:? *429/i, /rate.?limit/i,
		/too many requests/i, /insufficient quota/i,
	];
	if (QUOTA_PATTERNS.some((p) => p.test(lower))) {
		return { type: "quota", shouldSwitch: true };
	}

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
	if (secs < 60) return `${secs}s`;
	return `~${Math.ceil(secs / 60)}m`;
}

// ── Debug 日志 ───────────────────────────────────────────────

function appendDebugLog(
	state: KeyState, keyIndex: number, errorType: ErrorType,
	errorMessage: string, action: string,
): void {
	if (!state.debugLog) state.debugLog = [];
	state.debugLog.push({
		timestamp: Date.now(), keyIndex, errorType,
		errorMessage: errorMessage.slice(0, 500), action,
	});
	if (state.debugLog.length > 50) state.debugLog = state.debugLog.slice(-50);
}

// ── 核心：轮换到下一个可用 key ───────────────────────────────

function rotateToNext(): void {
	const keys = readKeys();
	const state = loadState();
	const total = keys.length;
	if (total === 0) return;

	let next = (state.index + 1) % total;
	let attempts = 0;
	while (isCooled(state.cooled[String(next)]) && attempts < total) {
		next = (next + 1) % total;
		attempts++;
	}
	if (attempts >= total) {
		next = findEarliestRecovery(state, total);
	}

	state.index = next;
	state.retryCount = 0;
	saveState(state);

	// 轮换后立即同步到 auth.json
	syncKeyToAuth();
}

function findEarliestRecovery(state: KeyState, total: number): number {
	let earliestIdx = 0;
	let earliestRemaining = Infinity;
	for (let i = 0; i < total; i++) {
		const remain = remainingCooldown(state.cooled[String(i)]);
		if (remain < earliestRemaining) {
			earliestRemaining = remain;
			earliestIdx = i;
		}
	}
	return earliestIdx;
}

function markCurrentCooled(reason: ErrorType): void {
	const state = loadState();
	const config = loadConfig();
	const cooldownForType =
		reason === "capacity" ? config.cooldownMs.capacity
		: reason === "quota" ? config.cooldownMs.quota
		: config.cooldownMs.network;

	if (cooldownForType <= 0 && reason === "network") return;

	state.cooled[String(state.index)] = {
		exhaustedAt: Date.now(),
		cooldownMs: cooldownForType,
		reason,
	};
	saveState(state);
}

// ── 自动探测 targetProvider ──────────────────────────────────

/**
 * 如果 config 没配 targetProvider，尝试从 auth.json 中自动探测：
 * 找到第一个 key 值匹配我们池中某个 key 的 provider
 */
function detectTargetProvider(): string {
	const keys = readKeys();
	if (keys.length === 0) return "";

	try {
		if (!existsSync(AUTH_FILE)) return "";
		const auth = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
		const poolKeySet = new Set(keys.map((e) => e.key));

		for (const [name, entry] of Object.entries(auth)) {
			if ((entry as any)?.type === "api_key" && poolKeySet.has((entry as any).key)) {
				return name;
			}
		}
	} catch {}
	return "";
}

// ── Extension 入口 ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	// ── 首次加载自动初始化 ─────────────────────────────────
	if (!existsSync(AGENT_DIR)) {
		mkdirSync(AGENT_DIR, { recursive: true });
	}
	if (!existsSync(KEYS_FILE) || readFileSync(KEYS_FILE, "utf-8").trim() === "") {
		writeFileSync(
			KEYS_FILE,
			JSON.stringify({ keys: [{ key: "", label: "key-1" }] }, null, 2),
			"utf-8",
		);
	}
	let config = loadConfig();
	if (!existsSync(CONFIG_FILE)) {
		writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
	}

	// 自动探测 targetProvider
	if (!config.targetProvider) {
		const detected = detectTargetProvider();
		if (detected) {
			config.targetProvider = detected;
			writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
		}
	}

	// ── 重试状态（闭包内，可访问 pi）────────────────────────────
	let isRetrying = false;

	function retryLastUserMessage(ctx: Parameters<ExtensionAPI["on"]>[1]): void {
		if (isRetrying) return;

		const branch = ctx.sessionManager.getBranch();
		const lastUser = branch
			.slice()
			.reverse()
			.find((e: any) => e.type === "message" && e.message?.role === "user");

		if (!lastUser?.message?.content) return;

		isRetrying = true;
		ctx.ui.notify("🔄 Switching key and retrying...", "warning");

		pi.sendMessage(
			{
				customType: "key-pool",
				content: `[auto-retry] ${typeof lastUser.message.content === "string"
					? lastUser.message.content
					: JSON.stringify(lastUser.message.content)
					}`,
				display: false,
			},
			{ deliverAs: "steer" },
		);

		setTimeout(() => { isRetrying = false; }, 5000);
	}

	// ════════════════════════════════════════════════════════════
	// 策略 1：新会话轮换
	// ════════════════════════════════════════════════════════════
	pi.on("session_start", (_event, ctx) => {
		const cfg = loadConfig();
		if (!cfg.retryOnSessionStart) return;

		const keys = readKeys();
		if (keys.length === 0) {
			ctx.ui.notify("key-pool: keys.json is empty — add keys and /reload", "error");
			return;
		}
		if (keys.length === 1) {
			ctx.ui.notify(`key-pool: 1 key loaded (${cfg.targetProvider || "no target"})`, "info");
			return;
		}

		const prev = loadState().index;
		rotateToNext();
		const curr = loadState().index;

		ctx.ui.notify(
			`key-pool: #${prev + 1} → #${curr + 1} of ${keys.length} → auth.json/${cfg.targetProvider}`,
			"info",
		);
	});

	// ════════════════════════════════════════════════════════════
	// 策略 2：错误检测 + 冷却 + 切换 + 重试
	// ════════════════════════════════════════════════════════════
	pi.on("turn_end", (event, ctx) => {
		if (isRetrying) return;

		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		if (msg.stopReason !== "error") return;

		const cfg = loadConfig();
		let state = loadState();
		const keys = readKeys();

		// 重试次数上限
		if (state.retryCount >= cfg.maxRetries) {
			const errMsg = msg.errorMessage ?? "unknown";
			ctx.ui.notify(
				`❌ key-pool: max retries (${cfg.maxRetries}) reached.${cfg.debug ? ` ${errMsg.slice(0, 120)}` : ""}`,
				"error",
			);
			if (cfg.debug) {
				appendDebugLog(state, state.index, "unknown", errMsg, "max-retries-exceeded");
				saveState(state);
			}
			state.retryCount = 0;
			saveState(state);
			return;
		}

		// 错误分类
		const classification = classifyError(msg.errorMessage);
		if (!classification.shouldSwitch) {
			if (classification.type === "network") {
				ctx.ui.notify(
					`⚡ key-pool: network error (not switching)${cfg.debug ? `: ${(msg.errorMessage ?? "").slice(0, 80)}` : ""}`,
					"info",
				);
				if (cfg.debug) {
					appendDebugLog(state, state.index, "network", msg.errorMessage ?? "", "no-switch");
					saveState(state);
				}
			}
			return;
		}

		const actualCooldown =
			classification.type === "capacity" ? cfg.cooldownMs.capacity : cfg.cooldownMs.quota;

		markCurrentCooled(classification.type);

		const oldIndex = state.index;
		rotateToNext();
		const newIndex = loadState().index;

		const updatedState = loadState();
		updatedState.retryCount++;
		if (cfg.debug) {
			appendDebugLog(updatedState, oldIndex, classification.type, msg.errorMessage ?? "", `switch→#${newIndex + 1}`);
		}
		saveState(updatedState);

		const errorPreview = (msg.errorMessage ?? "").slice(0, 80);
		pi.sendMessage(
			{
				customType: "key-pool",
				content: `⚠️ #${oldIndex + 1} [${classification.type}] ${errorPreview}\n   → #${newIndex + 1}${actualCooldown > 0 ? ` (${formatCooldown(actualCooldown)} cooldown)` : ""} → auth.json`,
				display: true,
			},
			{ deliverAs: "followUp" },
		);

		retryLastUserMessage(ctx);
	});

	// ════════════════════════════════════════════════════════════
	// 命令：查看池状态
	// ════════════════════════════════════════════════════════════
	pi.registerCommand("pool-status", {
		description: "查看 key pool 状态（活跃 key、冷却情况、重试计数）",
		handler: async (_args, ctx) => {
			const keys = readKeys();
			const state = loadState();
			const cfg = loadConfig();

			if (keys.length === 0) {
				ctx.ui.notify("key-pool: keys.json is empty or not found", "error");
				return;
			}

			const activeCooled = Object.values(state.cooled).filter((e) => isCooled(e)).length;

			const lines: string[] = [];
			lines.push(`Key Pool: ${keys.length} keys | #${state.index + 1} active | ${activeCooled} cooling`);
			lines.push(`Target: auth.json/${cfg.targetProvider || "(auto-detect)"}`);
			lines.push("");

			for (let i = 0; i < keys.length; i++) {
				const keyEntry = keys[i];
				const masked = keyEntry.key.slice(0, 14) + "...";
				const label = keyEntry.label ? `(${keyEntry.label})` : "";
				const parts: string[] = [];

				if (i === state.index) parts.push("◀ active");

				const cooled = state.cooled[String(i)];
				if (cooled && isCooled(cooled)) {
					parts.push(`❄️ ${cooled.reason} ${formatCooldown(remainingCooldown(cooled))}`);
				} else if (cooled) {
					parts.push(`✅ ${cooled.reason} (recovered)`);
				}

				lines.push(`  #${i + 1}  ${masked}${label}${parts.length ? "  — " + parts.join(", ") : ""}`);
			}

			lines.push("");
			lines.push(`Retry: ${state.retryCount}/${cfg.maxRetries} | Debug: ${cfg.debug ? "ON" : "OFF"}`);
			lines.push(`Cooldowns: capacity=${cfg.cooldownMs.capacity / 1000}s, quota=${cfg.cooldownMs.quota / 1000}s, network=${cfg.cooldownMs.network > 0 ? cfg.cooldownMs.network / 1000 + "s" : "off"}`);

			if (cfg.debug && state.debugLog && state.debugLog.length > 0) {
				lines.push("");
				lines.push("--- Debug Log (recent) ---");
				for (const e of state.debugLog.slice(-10)) {
					const time = new Date(e.timestamp).toLocaleTimeString();
					lines.push(`  [${time}] #${e.keyIndex + 1} [${e.errorType}] ${e.action}: ${e.errorMessage.slice(0, 80)}`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ════════════════════════════════════════════════════════════
	// 命令：手动清除所有冷却标记
	// ════════════════════════════════════════════════════════════
	pi.registerCommand("pool-reset", {
		description: "清除所有 key 的冷却标记（立即恢复全部可用）",
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
}

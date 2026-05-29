/**
 * pi-key-pool — API Key Pool Manager for pi
 *
 * 核心能力：
 *   1. 新会话轮换   — session_start 时自动切换到下一个可用 key（保缓存）
 *   2. 冷却恢复     — 失败 key 带时间戳标记，到期自动恢复
 *   3. 自动重试     — 切换 key 后自动重发上一条用户消息（用户无感）
 *   4. 错误分类     — capacity / quota / network 三类独立策略
 *
 * 配置文件：
 *   ~/.pi/api-keys.txt     — key 池（每行一个，# 注释）
 *   ~/.pi/pool-config.json — 可选配置（冷却时间、重试次数等）
 *   ~/.pi/.key-state       — 运行时状态（自动维护）
 *
 * 用法：
 *   models.json 中 apiKey 设为 "!bash ~/.pi/get-current-key.sh"
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 路径常量 ────────────────────────────────────────────────

const HOME = process.env.HOME || "";
const KEYS_FILE = join(HOME, ".pi", "api-keys.txt");
const STATE_FILE = join(HOME, ".pi", ".key-state");
const CONFIG_FILE = join(HOME, ".pi", "pool-config.json");

// ── 类型定义 ─────────────────────────────────────────────────

/** 单个 key 的冷却记录 */
interface CooldownEntry {
	/** 该 key 被标记冷却的时间戳 (ms) */
	exhaustedAt: number;
	/** 冷却时长 (ms) */
	cooldownMs: number;
	/** 触发冷却的错误类型 */
	reason: ErrorType;
}

/** 状态文件结构 */
interface KeyState {
	/** 当前活跃 key 的索引 */
	index: number;
	/** 各 key 的冷却记录，key 为索引字符串 */
	cooled: Record<string, CooldownEntry>;
	/** 本会话内已连续重试次数 */
	retryCount: number;
}

/** 错误类型分类 */
type ErrorType = "capacity" | "quota" | "network" | "unknown";

/** 错误分类结果 */
interface ErrorClassification {
	type: ErrorType;
	shouldSwitch: boolean;
	cooldownMs: number;
}

/** 用户可配项 */
interface PoolConfig {
	cooldownMs: {
		capacity: number;
		quota: number;
		network: number;
	};
	maxRetries: number;
	retryOnSessionStart: boolean;
}

// ── 默认配置 ─────────────────────────────────────────────────

const DEFAULT_CONFIG: PoolConfig = {
	cooldownMs: {
		capacity: 30_000,     // 30 秒 — overloaded 通常是瞬时的
		quota: 300_000,       // 5 分钟 — rate limit 标准恢复时间
		network: 0,           // 不冷却 — 网络问题不应标记 key
	},
	maxRetries: 3,
	retryOnSessionStart: true,
};

// ── 文件读写 ─────────────────────────────────────────────────

function loadConfig(): PoolConfig {
	try {
		if (!existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
		const raw = readFileSync(CONFIG_FILE, "utf-8").trim();
		if (!raw) return DEFAULT_CONFIG;
		const parsed = JSON.parse(raw);
		return { ...DEFAULT_CONFIG, ...parsed };
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
		// 兼容旧格式：failed 数组 → cooled 对象
		if (Array.isArray(parsed.failed)) {
			return {
				index: parsed.index ?? 0,
				cooled: Object.fromEntries(
					parsed.failed.map((i: number) => [
						String(i),
						{
							exhaustedAt: Date.now(),
							cooldownMs: loadConfig().cooldownMs.quota,
							reason: "quota" as ErrorType,
						},
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

function readKeys(): string[] {
	try {
		const raw = readFileSync(KEYS_FILE, "utf-8");
		return raw
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("#"));
	} catch {
		return [];
	}
}

// ── 错误分类（借鉴 HA 三分法）──────────────────────────────────

/**
 * 将错误消息分类为 capacity / quota / network 三类
 * 每类决定不同的冷却时间和是否切换 key
 */
function classifyError(msg?: string): ErrorClassification {
	if (!msg) return { type: "unknown", shouldSwitch: false, cooldownMs: 0 };

	const lower = msg.toLowerCase();

	// ── Network errors → 不切换 key，不冷却（瞬时问题）───────
	const NETWORK_PATTERNS = [
		/internal network failure/i,
		/api_error/i,
		/network failure/i,
		/connection reset/i,
		/connection refused/i,
		/etimedout/i,
		/econnreset/i,
		/econnrefused/i,
		/socket hang up/i,
		/fetch failed/i,
	];
	if (NETWORK_PATTERNS.some((p) => p.test(lower))) {
		return { type: "network", shouldSwitch: false, cooldownMs: 0 };
	}

	// ── Capacity errors → 切换 + 短冷却（服务端过载）────────
	const CAPACITY_PATTERNS = [
		/capacity/i,
		/no capacity/i,
		/engine overloaded/i,
		/overloaded/i,
		/status_code:? *529/i,
	];
	if (CAPACITY_PATTERNS.some((p) => p.test(lower))) {
		return { type: "capacity", shouldSwitch: true, cooldownMs: 0 }; // 由 config 决定
	}

	// ── Quota errors → 切换 + 标准冷却（限流/配额）──────────
	const QUOTA_PATTERNS = [
		/status_code:? *429/i,
		/rate.?limit/i,
		/too many requests/i,
		/insufficient quota/i,
	];
	if (QUOTA_PATTERNS.some((p) => p.test(lower))) {
		return { type: "quota", shouldSwitch: true, cooldownMs: 0 }; // 由 config 决定
	}

	// 未匹配 → 不处理
	return { type: "unknown", shouldSwitch: false, cooldownMs: 0 };
}

// ── 冷却判断 ─────────────────────────────────────────────────

/**
 * 检查某个 key 是否仍在冷却期
 */
function isCooled(entry: CooldownEntry | undefined): boolean {
	if (!entry) return false; // 无冷却记录 = 可用
	return Date.now() - entry.exhaustedAt < entry.cooldownMs;
}

/**
 * 获取某 key 的剩余冷却时间（毫秒），已过期返回 0
 */
function remainingCooldown(entry: CooldownEntry | undefined): number {
	if (!entry) return 0;
	const elapsed = Date.now() - entry.exhaustedAt;
	return Math.max(0, entry.cooldownMs - elapsed);
}

/**
 * 格式化剩余时间为人类可读
 */
function formatCooldown(ms: number): string {
	if (ms <= 0) return "";
	const secs = Math.ceil(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.ceil(secs / 60);
	return `~${mins}m`;
}

// ── 核心：轮换到下一个可用 key ───────────────────────────────

/**
 * 从当前位置往后找第一个不在冷却期的 key
 * 全部冷却中则取冷却最早到期的那个
 */
function rotateToNext(): void {
	const keys = readKeys();
	const state = loadState();
	const config = loadConfig();
	const total = keys.length;
	if (total === 0) return;

	// 找下一个非冷却中的 key
	let next = (state.index + 1) % total;
	let attempts = 0;
	while (isCooled(state.cooled[String(next)]) && attempts < total) {
		next = (next + 1) % total;
		attempts++;
	}

	// 全部在冷却中 → 选一个最早恢复的
	if (attempts >= total) {
		next = findEarliestRecovery(state, total);
	}

	state.index = next;
	state.retryCount = 0; // 新 key 重置重试计数
	saveState(state);
}

/**
 * 所有 key 都在冷却时，找最早到期的一个
 */
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

// ── 核心标记当前 key 冷却 ────────────────────────────────────

function markCurrentCooled(reason: ErrorType): void {
	const state = loadState();
	const config = loadConfig();

	const cooldownForType =
		reason === "capacity"
			? config.cooldownMs.capacity
			: reason === "quota"
				? config.cooldownMs.quota
				: config.cooldownMs.network;

	// network 类型且 cooldown=0 则不标记
	if (cooldownForType <= 0 && reason === "network") return;

	state.cooled[String(state.index)] = {
		exhaustedAt: Date.now(),
		cooldownMs: cooldownForType,
		reason,
	};
	saveState(state);
}

// ── 核心自动重试（借鉴 HA retryTurn）──────────────────────────

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

	// 防重入锁 5 秒后释放
	setTimeout(() => { isRetrying = false; }, 5000);
}

// ── Extension 入口 ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	// ════════════════════════════════════════════════════════════
	// 策略 1：新会话轮换
	// ════════════════════════════════════════════════════════════
	pi.on("session_start", (_event, ctx) => {
		const config = loadConfig();
		if (!config.retryOnSessionStart) return;

		const keys = readKeys();
		if (keys.length <= 1) {
			if (keys.length === 1) {
				ctx.ui.notify(`key-pool: 1 key loaded`, "info");
			} else {
				ctx.ui.notify("key-pool: api-keys.txt is empty", "error");
			}
			return;
		}

		const prev = loadState().index;
		rotateToNext();
		const curr = loadState().index;

		ctx.ui.notify(
			`key-pool: key #${prev + 1} → #${curr + 1} of ${keys.length}`,
			"info",
		);
	});

	// ════════════════════════════════════════════════════════════
	// 策略 2：错误检测 + 冷却 + 切换 + 重试
	// 用 turn_end（不是 message_end）— 和 HA 一致，
	// 确保 tool calls 全部完成后再做判断
	// ════════════════════════════════════════════════════════════
	pi.on("turn_end", (event, ctx) => {
		// 防重入：如果正在重试中，跳过
		if (isRetrying) return;

		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		if (msg.stopReason !== "error") return;

		const config = loadConfig();
		const state = loadState();
		const keys = readKeys();

		// 重试次数上限检查
		if (state.retryCount >= config.maxRetries) {
			ctx.ui.notify(
				`❌ key-pool: max retries (${config.maxRetries}) reached. Giving up.`,
				"error",
			);
			state.retryCount = 0;
			saveState(state);
			return;
		}

		// 错误分类
		const classification = classifyError(msg.errorMessage);
		if (!classification.shouldSwitch) {
			// network error → 不切 key，让 pi 自己的重试机制处理
			if (classification.type === "network") {
				ctx.ui.notify(
					`⚡ key-pool: network error (not switching key)`,
					"info",
				);
			}
			return;
		}

		// 取该类型的实际冷却时间
		const actualCooldown =
			classification.type === "capacity"
				? config.cooldownMs.capacity
				: config.cooldownMs.quota;

		// 标记当前 key 冷却
		markCurrentCooled(classification.type);

		// 记录旧索引用于通知
		const oldIndex = state.index;

		// 切换到下一个可用 key
		rotateToNext();
		const newIndex = loadState().index;

		// 递增重试计数
		const updatedState = loadState();
		updatedState.retryCount++;
		saveState(updatedState);

		// 通知用户
		const errorPreview = (msg.errorMessage ?? "").slice(0, 80);
		pi.sendMessage(
			{
				customType: "key-pool",
				content: `⚠️ #${oldIndex + 1} [${classification.type}] ${errorPreview}\n   → switched to #${newIndex + 1}${actualCooldown > 0 ? ` (${formatCooldown(actualCooldown)} cooldown)` : ""}`,
				display: true,
			},
			{ deliverAs: "followUp" },
		);

		// 自动重试上一条消息
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
			const config = loadConfig();

			if (keys.length === 0) {
				ctx.ui.notify("api-keys.txt 为空或不存在", "error");
				return;
			}

			const now = Date.now();
			const cooledCount = Object.keys(state.cooled).length;
			const activeCooled = Object.entries(state.cooled).filter(
				([, entry]) => isCooled(entry),
			).length;

			const lines: string[] = [];
			lines.push(`Key Pool: ${keys.length} keys | #${state.index + 1} active | ${activeCooled} cooling`);
			lines.push("");

			for (let i = 0; i < keys.length; i++) {
				const masked = keys[i].slice(0, 14) + "...";
				const parts: string[] = [];

				// 当前标记
				if (i === state.index) parts.push("◀ active");

				// 冷却状态
				const entry = state.cooled[String(i)];
				if (entry && isCooled(entry)) {
					parts.push(`❄️ ${entry.reason} ${formatCooldown(remainingCooldown(entry))}`);
				} else if (entry) {
					parts.push(`✅ ${entry.reason} (recovered)`);
				}

				lines.push(`  #${i + 1}  ${masked}${parts.length ? "  — " + parts.join(", ") : ""}`);
			}

			lines.push("");
			lines.push(`Retry count this session: ${state.retryCount}/${config.maxRetries}`);
			lines.push(`Cooldowns: capacity=${config.cooldownMs.capacity / 1000}s, quota=${config.cooldownMs.quota / 1000}s, network=${config.cooldownMs.network > 0 ? config.cooldownMs.network / 1000 + "s" : "off"}`);

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
			saveState(state);
			ctx.ui.notify(`Pool reset: ${count} cooldowns cleared`, "info");
		},
	});
}

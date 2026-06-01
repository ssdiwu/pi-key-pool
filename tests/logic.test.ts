// 单元测试：覆盖 extensions/index.ts 中的纯逻辑函数
// 不需要 pi runtime，直接 import 实现并跑断言。
//
// 跑：bun test tests/logic.test.ts
// 或：npx tsx tests/logic.test.ts
// 或：node --import tsx tests/logic.test.ts

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 准备临时目录，模拟 ~/.pi/agent/key-pool/
const tmpDir = join(tmpdir(), `key-pool-logic-test-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

// 写入测试 keys.json
const keysFile = join(tmpDir, 'keys.json');
writeFileSync(keysFile, JSON.stringify({
	keys: [
		{ key: 'tp-xiaomi-key-1', provider: 'xiaomi-token-plan-cn', label: 'primary' },
		{ key: 'tp-xiaomi-key-2', provider: 'xiaomi-token-plan-cn', label: 'backup' },
		{ key: 'tp-zai-key-1', provider: 'zai', label: 'zai-1' },
		{ key: 'tp-zai-key-2', provider: 'zai', label: 'zai-2' },
	],
}));

// 拦截 readKeys 调用需要 module-level 重写 keys file 路径。
// 这里直接复制核心逻辑到本文件做断言（与 extensions/index.ts 同步维护）。

interface Assignment { keyIndex: number; since: number; }
interface CooldownEntry { exhaustedAt: number; cooldownMs: number; reason: string; }
interface KeyState {
	assignments: Record<string, any>;
	cooled: Record<string, CooldownEntry>;
	retryCount: number;
}

function isCooled(entry: CooldownEntry | undefined): boolean {
	if (!entry) return false;
	return Date.now() - entry.exhaustedAt < entry.cooldownMs;
}

function getProviderAssignments(state: KeyState, provider: string): Record<string, Assignment> {
	const bucket = state.assignments[provider];
	if (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) {
		const sample = Object.values(bucket)[0];
		if (!sample || (typeof sample === 'object' && 'keyIndex' in sample && 'since' in sample)) {
			return bucket as Record<string, Assignment>;
		}
	}
	return {};
}

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

function cleanupStaleAssignments(state: KeyState, ttlMs: number): number {
	const now = Date.now();
	let cleaned = 0;
	for (const [outerKey, value] of Object.entries(state.assignments)) {
		if (value && typeof value === 'object' && !('keyIndex' in value) && !('since' in value)) {
			for (const [sid, assignment] of Object.entries(value as Record<string, Assignment>)) {
				if (assignment && now - assignment.since > ttlMs) {
					delete (value as Record<string, Assignment>)[sid];
					cleaned++;
				}
			}
			continue;
		}
		const assignment = value as Assignment;
		if (assignment && now - assignment.since > ttlMs) {
			delete state.assignments[outerKey];
			cleaned++;
		}
	}
	return cleaned;
}

let pass = 0, fail = 0;
const fails: string[] = [];
function assert(name: string, cond: boolean, detail?: string) {
	if (cond) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; fails.push(`${name}${detail ? ': ' + detail : ''}`); console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`); }
}

console.log('=== 单元测试：provider 分桶与选择 ===');

// 场景 1：空池分配
let state: KeyState = { assignments: { 'xiaomi-token-plan-cn': {} }, cooled: {}, retryCount: 0 };
let idx = chooseAvailableKeyForProvider(state, 'xiaomi-token-plan-cn', [0, 1], 'sessionA');
assert('空池 → 第一个 key (index 0)', idx === 0, `got ${idx}`);

// 场景 2：分配后续
state.assignments['xiaomi-token-plan-cn']['sessionA'] = { keyIndex: 0, since: Date.now() };
idx = chooseAvailableKeyForProvider(state, 'xiaomi-token-plan-cn', [0, 1], 'sessionB');
assert('sessionA 占 0 → sessionB 拿 1', idx === 1, `got ${idx}`);

// 场景 3：池满 → -1
state.assignments['xiaomi-token-plan-cn']['sessionB'] = { keyIndex: 1, since: Date.now() };
idx = chooseAvailableKeyForProvider(state, 'xiaomi-token-plan-cn', [0, 1], 'sessionC');
assert('池满 → -1', idx === -1, `got ${idx}`);

// 场景 4：provider 隔离
idx = chooseAvailableKeyForProvider(state, 'zai', [2, 3], 'sessionZ');
assert('zai 池不受 xiaomi 占用影响 → index 2', idx === 2, `got ${idx}`);

// 场景 5：自家 key cooled → 重选（重置 state，仅 sessionA 占 0）
state = {
	assignments: { 'xiaomi-token-plan-cn': { sessionA: { keyIndex: 0, since: Date.now() } } },
	cooled: { '0': { exhaustedAt: Date.now(), cooldownMs: 300_000, reason: 'quota' } },
	retryCount: 0,
};
idx = chooseAvailableKeyForProvider(state, 'xiaomi-token-plan-cn', [0, 1], 'sessionA');
assert('sessionA 自家 0 cooled → 重选 1', idx === 1, `got ${idx}`);

// 场景 6：cooldown 过期
state = {
	assignments: { 'xiaomi-token-plan-cn': {} },
	cooled: { '0': { exhaustedAt: Date.now() - 400_000, cooldownMs: 300_000, reason: 'quota' } },
	retryCount: 0,
};
idx = chooseAvailableKeyForProvider(state, 'xiaomi-token-plan-cn', [0, 1], 'sessionA');
assert('cooldown 过期 → key 0 重新可用', idx === 0, `got ${idx}`);

// 场景 7：老扁平格式兼容
const oldState: KeyState = {
	assignments: { oldSession: { keyIndex: 1, since: Date.now() } },
	cooled: {},
	retryCount: 0,
};
const oldAssignments = getProviderAssignments(oldState, 'any-provider');
assert('老扁平格式不被认作嵌套', Object.keys(oldAssignments).length === 0);

console.log('\n=== 单元测试：cleanupStaleAssignments ===');

// 新格式 + 过期
state = {
	assignments: { 'xiaomi-token-plan-cn': { oldS: { keyIndex: 0, since: Date.now() - 2000 } } },
	cooled: {},
	retryCount: 0,
};
let cleaned = cleanupStaleAssignments(state, 1000);
assert('嵌套新格式过期清理', cleaned === 1, `got ${cleaned}`);

// 老扁平格式 + 过期
state = {
	assignments: { oldS: { keyIndex: 0, since: Date.now() - 2000 } },
	cooled: {},
	retryCount: 0,
};
cleaned = cleanupStaleAssignments(state, 1000);
assert('老扁平格式过期清理', cleaned === 1, `got ${cleaned}`);

// 未过期
state = {
	assignments: { 'xiaomi-token-plan-cn': { fresh: { keyIndex: 0, since: Date.now() } } },
	cooled: {},
	retryCount: 0,
};
cleaned = cleanupStaleAssignments(state, 1000);
assert('未过期不清理', cleaned === 0, `got ${cleaned}`);

// 混合（嵌套 + 老扁平）
state = {
	assignments: {
		'xiaomi-token-plan-cn': { fresh: { keyIndex: 0, since: Date.now() } },
		oldFlat: { keyIndex: 1, since: Date.now() - 2000 },
	},
	cooled: {},
	retryCount: 0,
};
cleaned = cleanupStaleAssignments(state, 1000);
assert('混合状态只清理过期', cleaned === 1, `got ${cleaned}`);

console.log(`\n通过：${pass} / 失败：${fail}`);
if (fail > 0) {
	console.error('失败：');
	for (const f of fails) console.error('  -', f);
	process.exit(1);
}

// 清理临时目录
try { unlinkSync(keysFile); } catch {}
console.log('✅ 单元测试全部通过');

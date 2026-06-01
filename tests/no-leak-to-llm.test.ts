// 回归测试：key-pool 不应通过 pi.sendMessage({ customType: ... }) 把内部状态
// 注入到 LLM 上下文（agent.state.messages）。
//
// 原因：pi-coding-agent 的 sendCustomMessage 实现会把 custom_message
// push 到 agent.state.messages，AI 下一轮会看到。如果 AI 看到
// "⚠️ key-pool: switched key #1 → #2" 这种消息，可能误以为是用户在告诉它切模型。
//
// 唯一应该进入 LLM 上下文的是 pi.sendUserMessage(content) —
// 那是为了让 AI 重新处理用户的原始请求。
//
// 跑：bun tests/no-leak-to-llm.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const indexFile = join(import.meta.dir, '..', 'extensions', 'index.ts');
const src = readFileSync(indexFile, 'utf-8');

let pass = 0, fail = 0;
const fails: string[] = [];
function assert(name: string, cond: boolean, detail?: string) {
	if (cond) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; fails.push(name + (detail ? ': ' + detail : '')); console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`); }
}

console.log('=== 回归测试：key-pool 不污染 LLM 上下文 ===');

// 1) 查找所有 pi.sendMessage 调用（除注释外）
const sendMessageMatches = [...src.matchAll(/pi\.sendMessage\s*\(/g)];
// 排除注释里的提及
const realSendMessageCalls = sendMessageMatches.filter((m) => {
	const lineStart = src.lastIndexOf('\n', m.index!) + 1;
	const lineEnd = src.indexOf('\n', m.index!);
	const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
	return !line.startsWith('//') && !line.startsWith('*');
});
assert(
	'pi.sendMessage 调用数为 0（不能注入 custom_message 到 LLM 上下文）',
	realSendMessageCalls.length === 0,
	`found ${realSendMessageCalls.length} call(s) at: ${realSendMessageCalls.map((m) => m.index).join(', ')}`
);

// 2) 应该有 pi.sendUserMessage 用法（让 AI 重新处理用户消息）
const sendUserMessageMatches = [...src.matchAll(/pi\.sendUserMessage\s*\(/g)];
assert(
	'pi.sendUserMessage 至少调用 1 次（retry 时让 AI 重新处理用户消息）',
	sendUserMessageMatches.length >= 1
);

// 3) sendUserMessage 调用的 content 应该是 lastUser.message.content（原始用户内容，不是装饰）
const sendUserMessageContext = src.includes('pi.sendUserMessage(lastUser.message.content');
assert(
	'pi.sendUserMessage 传的是 lastUser.message.content（原始用户消息，无装饰）',
	sendUserMessageContext
);

// 4) 状态显示用 ctx.ui.notify（不进 LLM 上下文）
const notifyMatches = [...src.matchAll(/ctx\.ui\.notify\s*\(/g)];
assert(
	'ctx.ui.notify 至少调用 1 次（状态显示给人类看，不进 LLM 上下文）',
	notifyMatches.length >= 5,  // 至少包括 session_start / network / cooling / retry 等场景
	`got ${notifyMatches.length}`
);

console.log(`\n${pass}/${pass + fail} assertions passed`);
if (fail > 0) {
	console.error('失败：');
	for (const f of fails) console.error('  -', f);
	console.error('\n如果修改了 sendMessage / sendUserMessage 的用法，请先确认：');
	console.error('- 注入给 LLM 的只有用户原始内容（pi.sendUserMessage）');
	console.error('- 任何调试/状态信息只能用 ctx.ui.notify（只显示给人类）');
	process.exit(1);
}
console.log('✅ 全部通过 — key-pool 不会污染 LLM 上下文');

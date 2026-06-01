// 提取 extensions/index.ts 里的 GET_CURRENT_KEY_SCRIPT 模板字面量并写入文件。
// 用 eval 处理 TS 模板字符串的转义（如 \${VAR} 转为 ${VAR}）。
//
// 用法：node extract-script.mjs <out-path>

import { readFileSync, writeFileSync } from 'fs';

const out = process.argv[2];
if (!out) {
	console.error('usage: extract-script.mjs <out-path>');
	process.exit(1);
}

const src = readFileSync(new URL('../extensions/index.ts', import.meta.url), 'utf-8');
const m = src.match(/const GET_CURRENT_KEY_SCRIPT = `([\s\S]*?)`;/);
if (!m) {
	console.error('GET_CURRENT_KEY_SCRIPT not found in extensions/index.ts');
	process.exit(1);
}

// 用 eval 求值模板字符串，去掉反斜杠转义
const evaluated = eval('`' + m[1] + '`');
writeFileSync(out, evaluated, { mode: 0o700 });
console.log(`Extracted ${evaluated.length} chars → ${out}`);

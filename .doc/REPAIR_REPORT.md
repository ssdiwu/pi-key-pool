# 修复报告

## 修复时间

2026-05-31

## 修复范围

本次修复聚焦代码审查中发现的阻塞问题：key 脚本部署、session assignment 读取、并行状态竞争、自动重试、配置兼容、安全脱敏与发包排除。

## 已修复问题

### 1. 动态 key 脚本缺失

- 问题：`models.json` 指向 `~/.pi/agent/key-pool/get-current-key.sh`，但安装包不部署该脚本。
- 修复：
  - 在 `extensions/index.ts` 内嵌 `GET_CURRENT_KEY_SCRIPT`
  - extension 启动时写入运行目录并设置 `0700`
  - 根目录 `get-current-key.sh` 同步更新，便于本地测试与审阅

### 2. 脚本读取旧状态格式

- 问题：脚本只读旧字段 `index`，忽略 `assignments` 和 `.current-session`。
- 修复：
  - 优先读取 `PI_KEY_POOL_SESSION_ID`
  - fallback 读取 `.current-session`
  - 从 `state.assignments[sessionId].keyIndex` 获取 key
  - 仅在缺少 assignment 时 fallback 到旧 `index` 或第一个非冷却 key

### 3. 并行 session 状态竞争

- 问题：`.key-state` 读改写没有锁，多个 pi 进程可能互相覆盖。
- 修复：
  - 增加 `.key-state.lock` 目录锁
  - 增加 stale lock 清理
  - 状态写入使用 temp file + `renameSync` 原子替换
  - 状态文件权限设置为 `0600`

### 4. 自动重试没有真正重发用户消息

- 问题：原实现用 `pi.sendMessage()` 发送 custom message，不能等价重发用户输入。
- 修复：
  - 改为 `pi.sendUserMessage(lastUser.message.content, { deliverAs: "followUp" })`
  - 保留 UI notify 作为提示

### 5. `.current-session` 多进程互相覆盖

- 问题：全局单文件在并行 session 下会被覆盖。
- 修复：
  - 主路径改用进程环境变量 `PI_KEY_POOL_SESSION_ID`
  - `.current-session` 只作为 fallback
  - shutdown 时只删除属于当前 session 的 fallback 文件

### 6. 错误分类误判

- 问题：`api_error` 过早归类为 network，可能吞掉 429/529。
- 修复：
  - 先匹配 capacity / quota 明确状态码和限流文案
  - 再匹配 network 错误
  - 移除宽泛 `/api_error/` network 规则

### 7. 配置迁移与 example 不一致

- 问题：浅合并会丢失 `cooldownMs` 子字段；example 含废弃字段且缺少 `assignmentTtlMs`。
- 修复：
  - 增加 `normalizeConfig()` 深层默认值和数值校验
  - 更新 `pool-config.example.json`

### 8. 敏感信息展示过多

- 问题：`/pool-status` 展示 key 前 14 位；debug log 可能保存 key。
- 修复：
  - key mask 改为前 6 后 4
  - debug/error preview 增加 `sk-` / `tp-` 风格 token 脱敏
  - `keys.json`、`.key-state`、配置文件尽量设置 `0600`

### 9. `models.json` 覆盖风险

- 问题：原实现解析失败时可能覆盖用户配置；路径未 shell quote。
- 修复：
  - `models.json` 解析失败时直接跳过，不覆盖
  - 首次写入前创建 `.bak-key-pool` 备份
  - `!bash` 脚本路径增加 shell quote

### 10. `.doc/` 不参与发包

- 修复：`.npmignore` 已添加 `.doc/` 排除规则。

## 验证记录

- `node --check extensions/index.ts`：通过
- `get-current-key.sh` 临时 HOME 场景：assignment `sid-abc -> keyIndex 1` 时输出 `KEY2`
- `npm run lint`：当前仍是 no-op，仅输出 `no linter configured`

## 残留建议

1. 增加真实 TypeScript 检查，例如 `tsc --noEmit`。
2. 增加单元测试覆盖：
   - assignment 读取
   - cooldown fallback
   - config migration
   - 并发分配锁
3. README 可进一步补充当前 `PI_KEY_POOL_SESSION_ID` 优先级和脚本部署机制。

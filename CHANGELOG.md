# Changelog

所有版本变更记录在案。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.2] - 2026-06-02

### Fixed
- **切 key 状态信息不再注入到 LLM 上下文**：原 `turn_end` 错误处理用
  `pi.sendMessage({ customType: "key-pool", content: "⚠️ #1 [quota]..." })` 推送切 key 状态。
  pi-coding-agent 的 `sendCustomMessage` 实现会把 custom_message 推入
  `agent.state.messages`，导致 AI 下一轮看到 "key-pool: switched key #1 → #2" 这种
  消息并可能误以为用户要它切模型。改为 `ctx.ui.notify(...)` 纯 UI 通知，不进 LLM 上下文。

### Added
- **回归测试** `tests/no-leak-to-llm.test.ts`：静态检查 `pi.sendMessage` 调用数
  必须为 0；`pi.sendUserMessage` 传原始用户内容。

## [0.3.1] - 2026-06-02

### Fixed
- **同步仓库根目录的 get-current-key.sh**：0.3.0 漏改了仓库根目录的独立脚本文件
  （不是从 extensions/index.ts 里的 GET_CURRENT_KEY_SCRIPT 字符串部署出来的）。
  后续 build agent 应在改动 GET_CURRENT_KEY_SCRIPT 字符串时同步更新根目录的
  get-current-key.sh。
- **老扁平 assignments 不再阻塞新分配**：0.3.0 在 bash 脚本 available 列表计算时把
  老扁平格式的 assignments（顶层 key 是 sessionId 而非 provider）当成了"已占用"，
  导致用户从 0.2.4 升级时残留的扁平 assignments 阻塞所有新 session 选 key，
  报 "all keys are cooling"。getProviderAssignments() 已经把老扁平格式视为空，
  bash 脚本不该再用它们当 taken 约束。

## [0.3.0] - 2026-06-02

### Changed
- **按需分配 + provider 白名单**：session_start 不再预先分配 key，改为在 `model_select` 事件中
  按需建立 session → provider 绑定。`turn_end` 错误处理加 provider 白名单判断：当前
  `ctx.model.provider` 不在 `keys.json` 登记的 provider 集合中时直接 `return`，不切 key、不重试、
  不发 key-pool 通知。

### Fixed
- **错误接管越权**：当 session 使用非 managed provider（如 zai/GLM、openai-codex）返回 429 时，
  key-pool 之前会误以为是它管理的 key 出问题，错误地切 key、重试、熔断，导致用户看到
  "consecutive 429/quota errors; auto retry stopped" 等与实际错误无关的提示。现在 zai 等
  单 key provider 的 429 错误会原样上抛给用户，key-pool 不再接管。

### Added
- **bash 脚本支持按 provider 选 key**：读取新增的 `PI_KEY_POOL_PROVIDER` 环境变量，从该 provider
  的 key 子集中分配；未设置时 fallback 到 keys.json 第一个带 provider 的 key。
- **`autoConfigureModelsJson` 遍历所有 managed provider**：之前只注入 `keys[0].provider` 的
  bash 脚本，现在 keys.json 中所有出现过的 provider 都会被注入。
- **`.key-state` 按 provider 分桶**：`assignments: { [provider]: { [sessionId]: { keyIndex, since } } }`，
  老的扁平格式仍可读取（向后兼容），首次 model_select 后自动写入新格式。
- **集成测试** `tests/scenarios.bash.sh` 和 **单元测试** `tests/logic.test.ts`，覆盖 9 个 GWT
  验收场景 + 11 个 provider 分桶边界用例。

## [0.2.4] - 2026-06-01

### Fixed
- **MODELS_FILE 路径错位**：扩展把 `!bash` 注入写到了 `~/.pi/models.json`，但 pi 实际读取的是
  `~/.pi/agent/models.json`（见 pi 官方 `docs/models.md`）。该 bug 导致之前所有版本的 key 池运行时
  逻辑（session 绑定、cooldown、自动切换、熔断）对当前 pi 完全无效。修复后 0.2.3 之前已发布版本
  受影响用户请升级到 0.2.4。

## [0.2.3] - 2026-05-31

### Fixed
- **熔断 Key 池连续限流重试**：连续触发 429 / quota 错误时停止自动重发，避免无限循环消耗用户
  上下文与配额。

## [0.2.2] - 2026-05-31

### Changed
- 发版流程调整（npm publish 触发点修正）。

## [0.2.1] - 2026-05-31

### Fixed
- 完善 key-pool 发包与重试逻辑。

## [0.2.0] - 2026-05-30

### Added
- **Session 绑定**：每个 session 独占一个 key，并行 session 自动使用不同 key。
- **启动时自动迁移 config**：旧版 `pool-config.json` 字段在加载时自动补齐。
- **Cooldown recovery**：失败 key 带时间戳标记，到期自动恢复，无需手动 reset。
- **Auto provider detection**：从 `keys.json` 的 `provider` 字段自动识别 pi provider，
  自动配置 `models.json`。
- **错误分类**：3 档独立策略 — `capacity` (30s) / `quota` (5min) / `network` (不切)。
- **智能重试**：失败时切换 key 并自动重发上一条用户消息。

## [0.1.0] - 2026-05-29

### Added
- **首次发布（v2 初始版本）**：
  - 重构到运行时目录 `~/.pi/agent/key-pool/`
  - `api-keys.txt` → `keys.json` 数据格式迁移 + 首次加载自动 init
  - `get-current-key.sh` 注入脚本
  - `/pool-status` 命令
  - Debug 模式（写入 `.key-state`）
  - Zombie session 清理（TTL 1h）
  - README + npm 发包就绪

[Unreleased]: https://github.com/ssdiwu/pi-key-pool/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/ssdiwu/pi-key-pool/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/ssdiwu/pi-key-pool/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/ssdiwu/pi-key-pool/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/ssdiwu/pi-key-pool/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ssdiwu/pi-key-pool/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ssdiwu/pi-key-pool/releases/tag/v0.1.0

# Changelog

所有版本变更记录在案。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

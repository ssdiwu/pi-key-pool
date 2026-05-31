# pi-key-pool 项目构成

## 项目定位

`pi-key-pool` 是一个 pi extension package，用于在多个 API key 之间按 session 分配、失败冷却、错误后切换并自动重试。

## 目录结构

```text
pi-key-pool/
├── extensions/
│   └── index.ts              # pi extension 入口，负责状态管理、命令、重试、脚本部署
├── get-current-key.sh        # 动态 apiKey 解析脚本；安装后会被 index.ts 部署到运行目录
├── keys.example.json         # keys.json 示例
├── pool-config.example.json  # pool-config.json 示例
├── package.json              # npm/pi package manifest
├── .npmignore                # 发包排除规则；.doc/ 不参与发包
├── README.md                 # 用户说明
└── .doc/
    ├── PROJECT_STRUCTURE.md  # 本文件
    └── REPAIR_REPORT.md      # 本次修复报告
```

## 运行时目录

extension 启动后会使用：

```text
~/.pi/agent/key-pool/
├── keys.json             # 用户真实 API key，0600
├── pool-config.json      # 配置，0600
├── .key-state            # assignments / cooldown / retry state，0600
├── .key-state.lock       # 跨进程状态锁目录，临时存在
├── .current-session      # fallback session id，0600
└── get-current-key.sh    # 部署后的动态 key 脚本，0700
```

## 关键流程

1. `session_start`
   - 生成 `currentSessionId`
   - 写入 `process.env.PI_KEY_POOL_SESSION_ID`
   - 为该 session 分配可用 key

2. 模型请求
   - `~/.pi/models.json` 中 provider 的 `apiKey` 被配置为 `!bash '<script>'`
   - shell 脚本读取 `PI_KEY_POOL_SESSION_ID` 和 `.key-state`
   - 输出当前 session 对应 key

3. `turn_end` 失败检测
   - 先判定 `429/529` 等明确状态码
   - 将当前 key 标记 cooldown
   - 重新分配新 key
   - 使用 `pi.sendUserMessage(..., { deliverAs: "followUp" })` 重发上一条用户消息

4. `session_shutdown`
   - 释放当前 session assignment
   - 清理本进程 env
   - 仅当 `.current-session` 属于当前 session 时删除 fallback 文件

## 发包说明

`.npmignore` 已显式排除 `.doc/`，因此本目录只作为本地维护文档，不参与 npm 包发布。

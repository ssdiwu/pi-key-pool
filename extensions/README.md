# extensions

该目录包含 `pi-key-pool` 的 pi 扩展入口代码。

## 入口

- `index.ts`：注册 key pool 扩展，负责读取运行时配置、分配 API Key、处理错误分类、冷却和自动重试。

## 运行时文件

扩展加载后会在 `~/.pi/agent/key-pool/` 下维护：

- `keys.json`：用户配置的 Key 池。
- `pool-config.json`：冷却、重试和调试配置。
- `.key-state`：session 绑定、冷却和重试状态。
- `get-current-key.sh`：供 `models.json` 使用的 `!bash` Key 注入脚本。

## 验证

当前仓库没有单元测试；修改后至少执行：

```bash
npm run lint
```

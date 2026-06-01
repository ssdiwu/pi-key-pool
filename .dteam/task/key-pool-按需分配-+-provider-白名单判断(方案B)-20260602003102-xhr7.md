# key-pool：按需分配 + provider 白名单判断（方案B）

## 基本信息
- ID: 20260602003102-xhr7
- 类型: refactor
- 创建时间: 2026-06-01T16:31:02.961Z
- 状态: done

## 目标
- 为什么: 当前 key-pool 在 session_start 预先绑定 key，且 turn_end 不判断 provider，导致非 managed provider（如 zai/GLM）返回 429 时被错误接管、误切 key、误重试；用户实际只有 xiaomi 多 key，zai 只有一个 key。
- 做什么: 重构 key-pool 的分配策略与会话介入条件：去掉 session_start 的预先绑定，改为 bash 脚本按需分配；turn_end 必须判断当前 message 的 provider 是否在 managed 列表中，只有匹配的 provider 错误才介入。

## 范围

### 包含
- `session_start` 不再预先 `assignKeyToSession`，只生成 sessionId 并写文件
- 新增 `model_select` 监听：在选择 model 时建立 session → provider 绑定（用于按 provider 选 key）
- `turn_end` 增加 provider 白名单判断：当前 model.provider 不在 `keys.json` 登记的 provider 列表中时直接 return，不切 key、不重试、不发通知
- `isManagedProvider(provider)` 辅助函数：基于 `keys.json` 中所有非空 key 的 provider 集合
- bash 脚本支持按 provider 选 key：读取 `PI_KEY_POOL_PROVIDER` env，从对应 provider 的 key 池中分配
- `autoConfigureModelsJson` 遍历所有 `keys` 中出现的 provider，分别注入 bash 脚本（而非只注入 `keys[0].provider`）
- `.key-state` 内部结构按 provider 分桶（`assignments: { [provider]: { [sessionId]: keyIndex } }`），避免多 provider 交叉
- 老的 `keys.json` / `pool-config.json` 格式保持不变，向后兼容

### 排除
- 不修改 pi-coding-agent 本身
- 不修改 `auth.json` 或 `models.json` 的非 key-pool 字段
- 不引入新的 npm 依赖
- 不实现 TUI 面板
- 不支持 OAuth provider 的多 key 切换（key-pool 本就不管 OAuth）

## 验收条件（GWT + 测试）

### 验收条件（GWT）

**场景 1：managed provider 失败 — 正常切 key**
- **Given** `keys.json` 配置了 2 个 `xiaomi-token-plan-cn` 的 key
- **And** 当前 session 选用的 model 是 xiaomi 的
- **When** xiaomi API 返回 429
- **Then** turn_end 触发 key-pool 切到 key #2
- **And** 自动重发上一条用户消息
- **And** UI 显示 `🔄 Switching key and retrying...`

**场景 2：非 managed provider 失败 — 不接管（核心 bug 修复）**
- **Given** `keys.json` 只配置了 xiaomi 的 key
- **And** `auth.json` 配置了 zai（GLM）的单 key
- **And** 当前 session 选用的 model 是 zai 的 glm-5v-turbo
- **When** zai API 返回 429 `Usage limit reached for 5 hour`
- **Then** turn_end 检查 `ctx.model.provider === "zai"` 不在 managed 集合中
- **And** 立即 return，不切 key、不重试、不发 key-pool 通知
- **And** zai 的错误信息原样上抛给用户（不被 key-pool 的 "consecutive 429/quota errors" 覆盖）

**场景 3：session_start 不预先分配 key**
- **Given** 用户启动 pi，进入新 session
- **When** session_start 触发
- **Then** 不调用 `assignKeyToSession`
- **And** 不写 `.key-state` 的 `assignments` 字段（直到 model_select 触发）
- **And** UI 不显示 `key-pool: session xxx → key #N` 通知
- **And** bash 脚本被首次调用时按需分配（基于 model_select 写入的 provider env）

**场景 4：model_select 建立 provider 绑定**
- **Given** session 已启动，keys.json 有 xiaomi 的多 key
- **When** 用户通过 `/model` 切换到 xiaomi 的某个 model
- **Then** model_select 触发，写入 `PI_KEY_POOL_PROVIDER=xiaomi-token-plan-cn` env
- **And** bash 脚本下次调用时识别 provider，输出对应 provider 的 key

**场景 5：multi-provider 并行**
- **Given** keys.json 有 2 个 xiaomi key、1 个 zai key
- **When** session 1 用 xiaomi，session 2 用 zai
- **Then** 两个 session 互不干扰
- **And** xiaomi 的 2 个 key 在多 session 间轮换
- **And** zai 始终用唯一的那一个 key

**场景 6：OAuth provider 自动跳过**
- **Given** session 用的是 openai-codex（OAuth）
- **When** 任何错误发生
- **Then** turn_end 检查到 provider 不在 managed 集合中
- **And** key-pool 完全不介入

**场景 7：autoConfigureModelsJson 注入全部 managed provider**
- **Given** keys.json 配置了 2 个不同 provider 的 key
- **When** 扩展加载
- **Then** `models.json` 中这 2 个 provider 的 `apiKey` 字段都被注入 bash 脚本
- **And** 不影响其他 provider 的 `apiKey`

**场景 8：state 文件迁移**
- **Given** 用户从旧版升级，老 `.key-state` 里有扁平的 `assignments: { [sessionId]: { keyIndex, since } }`
- **When** 首次加载新版
- **Then** 旧格式仍能解析（assignments 字段读取为空，不报错）
- **And** 首次 model_select 后写入新格式 `{ [provider]: { [sessionId]: { keyIndex, since } } }`

**场景 9：/pool-status 仍可读**
- **Given** 升级后正常运行
- **When** 用户执行 `/pool-status`
- **Then** 输出格式保持兼容，按 provider 分组显示
- **And** 不报"no non-empty keys"

## 阶段记录

### 探索发现

#### Bug 定位
- `extensions/index.ts` 的 `session_start` 无条件给当前 session 分配 key（来自 `keys.json` 第一个 key，即 xiaomi 的）
- `turn_end` 监听器只看 `currentSessionId` 是否存在，**不判断当前 turn 实际用的 provider**
- 用户在 `auth.json` 配了 zai（GLM）单 key，`models.json` 中 zai 的 apiKey 是静态的（走 auth.json），没走 bash 脚本
- 后果：zai 触发 429 时，key-pool 误以为是 xiaomi key 出问题，错误地切 key、重试、熔断

#### 关键 SDK 证据
- `ctx.model: Model<any> | undefined` — 扩展 hook 可直接拿到当前 model
- `Model.provider: Provider`（`Provider = KnownProvider | string`）— 拿当前 provider 字符串
- `model_select` 事件：`{ model, previousModel, source }` — 在 turn 之前就能感知 provider 切换
- `turn_end` 事件：`{ turnIndex, message, toolResults }` — 错误处理入口
- `pi-agent-core` 类型：assistant message 也带 model 字段，但优先用 `ctx.model`（更稳定）

#### 用户的实际配置
- `~/.pi/agent/auth.json`：`zai`、`minimax-cn`、`deepseek`、`openai-codex`（OAuth）、`xiaomi-token-plan-cn`
- `~/.pi/agent/key-pool/keys.json`：2 个 `xiaomi-token-plan-cn` key（primary + backup）
- `~/.pi/agent/models.json`：zai 的 apiKey 是 zai 自己的 key，没注入 bash 脚本；xiaomi 注入了 bash 脚本
- **结论**：key-pool 只该管 xiaomi，zai 等其他 provider 完全不该介入

### 讨论决策

#### 最终方案：方案 B — 按需分配 + provider 白名单

**核心思路**
1. **session_start 不再预先分配 key**：只生成 sessionId 并写环境/文件，等首次 model_select 触发绑定
2. **model_select 建立 session → provider 绑定**：用户选 model 时，记录 session 当前用的是哪个 provider
3. **turn_end 加 provider 白名单检查**：从 `ctx.model.provider` 拿到当前 provider，不在 `keys.json` 登记的 provider 集合中时直接 return，不切 key、不重试、不发通知
4. **bash 脚本按 provider 选 key**：读取 `PI_KEY_POOL_PROVIDER` env，从对应 provider 的 key 池中分配
5. **state 按 provider 分桶**：`assignments: { [provider]: { [sessionId]: { keyIndex, since } } }`，避免多 provider 交叉污染

#### 技术选型理由

| 决策 | 选项 | 理由 |
|------|------|------|
| provider 识别来源 | `ctx.model.provider`（hook 上下文）| 类型清晰（`Model<any>.provider: string`）、零额外调用、不依赖消息内容 |
| 替代方案：`event.message.model` | 备选 | 需要确认 assistant message 一定带 model 字段；`ctx.model` 是 SDK 公开的稳定 API |
| 替代方案：读 models.json 反查 | 不可行 | bash 脚本也能读，但与"provider 来源应是 LLM 实际调用方"语义不符 |
| assignment 按 provider 分桶 | 选 | 多 provider 并行时防止"session 抢别人 provider 的 key"；不选会导致 zai session 抢 xiaomi 槽位 |
| 替代方案：扁平 assignments + provider 标记 | 备选 | 增加复杂度且容易出 bug，分桶更干净 |
| 老的 `.key-state` 兼容策略 | 读到空 + 不报错 | 旧版升级用户不丢数据但 assignments 失效，让 model_select 重新建；简单可靠 |
| bash 脚本 env 名 | `PI_KEY_POOL_PROVIDER` | 与现有 `PI_KEY_POOL_SESSION_ID` 命名一致；清晰可读 |
| 注入 bash 到多 provider | 遍历 keys 中所有 provider | 用户的 GLM 场景下 zai 也能按需切（虽然只有 1 个 key），未来加 zai 多 key 也兼容 |
| `isManagedProvider` 计算时机 | 每次调用时 readKeys | keys.json 可能热更新；缓存反而会出 bug；读取是同步小操作，性能无压力 |
| model_select vs 首次 turn | model_select | 在 turn 之前就知道 provider，bash 首次调用就能选对 key；首次 turn 会太晚 |
| session_start 仍生成 sessionId | 保留 | bash 脚本和 turn_end 都需要 sessionId 做隔离，不删 |

#### 权衡取舍

**为什么不彻底删掉 session_start 的 sessionId 生成？**
- bash 脚本读取 `PI_KEY_POOL_SESSION_ID` 做 session 隔离
- turn_end 用它做 retry 计数
- 删了改动面更大；保留是低成本且必要的

**为什么不缓存 `isManagedProvider` 结果？**
- 每次 turn_end 都 readKeys → keys.json 文件 I/O
- 估计每次 readKeys 约 1ms，turn 频率低（人类节奏）
- 不缓存 = 配置文件热更新立即生效，运维更简单
- 如果未来性能成瓶颈再加 LRU

**为什么 `.key-state` 要按 provider 分桶而不是按 session 维度隔离？**
- session 可能切换 provider（用户用 `/model` 切到 zai）
- 同一个 session 在不同 provider 下应使用不同 key
- 分桶后 session 在 provider A 的 key 失效切换，不会污染 provider B 的状态
- 老的"session → keyIndex"映射本质上隐含了"session 只用一个 provider"的假设，多 provider 场景下必须打破

**为什么不监听 `before_provider_request`？**
- 看了扩展事件列表确实有 `BeforeProviderRequestEvent`，比 `model_select` 更精确（每次请求前）
- 但 `model_select` 只在切换时触发，开销更低；`ctx.model` 又是稳定 API
- `BeforeProviderRequestEvent` 适合"做请求改写"，不适合做"分配资源"语义
- 决定不引入，避免不必要的复杂度

#### 实施步骤

**Step 1：扩展核心逻辑（按文件顺序）**

1.1. **新增 `isManagedProvider(provider: string): boolean`**
- 读 keys.json，收集所有非空 key 的 provider 字段
- 返回 `Set.has(provider)`

1.2. **改造 `assignKeyToSession` → `assignKeyToProviderSession(provider, sessionId)`**
- 接收 provider 参数
- 写 state 时按 provider 分桶：`state.assignments[provider] ??= {}`
- 内部 `chooseAvailableKey` 只在该 provider 对应的 keys 子集中选
- 辅助：维护 `providerKeys: Record<provider, KeyEntry[]>` 索引（每次 readKeys 时构建）

1.3. **改造 `chooseAvailableKey` 为 `chooseAvailableKeyForProvider(state, provider, total)`**
- 只在该 provider 的 keyIndex 范围内选（需要给每个 provider 维护独立索引）

1.4. **改造 `releaseSessionAssignment` → `releaseProviderSession(provider, sessionId)`**
- 只清理 `state.assignments[provider][sessionId]`

1.5. **改造 `switchSessionKeyAfterError` → `switchProviderSessionKey(provider, sessionId, ...)`**
- 同上，限定在 provider 范围内

1.6. **session_start 改造**
- 删除 `assignKeyToSession` 调用
- 删除对应 notify
- 保留 sessionId 生成、写文件、写 env

1.7. **新增 `model_select` 监听**
```ts
pi.on("model_select", (event, ctx) => {
    if (!currentSessionId) return;
    const provider = event.model.provider;
    if (!provider || !isManagedProvider(provider)) {
        // 非 managed provider：清除 provider env，让 bash 走 fallback
        delete process.env.PI_KEY_POOL_PROVIDER;
        return;
    }
    process.env.PI_KEY_POOL_PROVIDER = provider;
    // 触发一次按需分配（让 session 立即绑定 key）
    assignKeyToProviderSession(provider, currentSessionId);
});
```

1.8. **turn_end 改造**
```ts
pi.on("turn_end", (event, ctx) => {
    if (!currentSessionId) return;
    const provider = ctx.model?.provider;
    if (!provider || !isManagedProvider(provider)) return;  // ← 关键
    // ... 原有错误处理逻辑，把所有 sessionId 操作改成限定 provider
});
```

1.9. **autoConfigureModelsJson 改造**
- 收集 `keys` 中所有非空 `provider`，去重
- 对每个 provider 注入 bash 脚本（替代当前只注入 `keys[0].provider`）

1.10. **bash 脚本 `GET_CURRENT_KEY_SCRIPT` 改造**
- 读取 `PI_KEY_POOL_PROVIDER` env
- 按 provider 过滤 keys
- 找不到 provider 对应的 key 时，fallback 到 keys.json 第一个 key（保留向后兼容）
- 输出对应 key

**Step 2：状态文件迁移**

- `loadStateUnlocked` 兼容老的扁平 `assignments` 字段（读到空）
- 首次 model_select 后写入新格式
- 不需要主动迁移旧数据（用户场景下旧数据只是 cooldown 标记，会自然过期）

**Step 3：测试**

3.1. 写一个集成测试脚本（`tests/scenarios.bash.sh`），覆盖 9 个验收场景
3.2. 手动验证：用户的 xiaomi + zai 实际环境跑一次
3.3. 跑 `pi -e extensions/index.ts --print "hello" --no-session --provider xiaomi` 冒烟

**Step 4：文档**

- 更新 `README.md` 的"Session-based binding"章节，反映按 provider 分桶的新模型
- CHANGELOG 写一条 Breaking-like 变更说明（虽然 keys.json 格式不变，但 state 内部结构变了）

#### 风险与回滚

- **风险 1**：bash 脚本解析 PI_KEY_POOL_PROVIDER 失败 → fallback 到 keys.json 第一个 key，最坏情况是 session 用错 provider 的 key，但 bash 的 `!bash` 注入只对配置了的 provider 生效，所以最坏也就是 401/403，不会污染
- **风险 2**：model_select 触发过于频繁（用户来回切）→ 每次都会重新分配 key，可能导致 cooldown 提前；解决方案：assignKeyToProviderSession 已绑定且未 cooled 时直接返回，不重新分配
- **风险 3**：用户老的 `.key-state` 含旧数据导致误判 → 兼容逻辑只读不写，等新逻辑覆盖
- **回滚方案**：所有改动集中在 `extensions/index.ts` + bash 脚本字符串，git revert 即可；无需清理运行时文件

#### 不实施

- 不在 session_start 时给"非 managed provider" 发 warning（避免噪音）
- 不实现 provider 维度的 TUI 面板（保持现有 `/pool-status` 命令）
- 不做 dry-run 模式（够用就行，YAGNI）

### 执行记录

**修改的文件**

1. `extensions/index.ts` — 核心重构
   - 类型：assignments 改为 `Record<string, Assignment> | Record<string, Record<string, Assignment>>` 支持嵌套/老格式 union
   - 新增 `isManagedProvider(provider)` / `getManagedProviders()` / `groupKeysByProvider(keys)`
   - 新增 `getProviderAssignments(state, provider)` — 兼容老扁平格式
   - `chooseAvailableKey` → `chooseAvailableKeyForProvider(state, provider, indexes, sessionId?)`，增加"自己 session 保留绑定"语义
   - `assignKeyToSession` → `assignKeyToProviderSession(provider, sessionId)`
   - `releaseSessionAssignment` → 遍历所有 provider 调用 `releaseProviderSession(provider, sessionId)`
   - `switchSessionKeyAfterError` → `switchProviderSessionKey(provider, sessionId, ...)`
   - `cleanupStaleAssignments` — 兼容老扁平 + 嵌套两种格式
   - `session_start` — 删除 `assignKeyToSession` 调用，保留 sessionId 生成
   - 新增 `model_select` 钩子 — 建立 provider 绑定 + 写 `PI_KEY_POOL_PROVIDER` env
   - `turn_end` — 增加 `if (!provider || !isManagedProvider(provider)) return;` 核心修复点
   - `autoConfigureModelsJson` — 遍历所有 provider 注入 bash 脚本
   - `GET_CURRENT_KEY_SCRIPT` — 读 `PI_KEY_POOL_PROVIDER`，按 provider 过滤 keys；available 列表跳过"已被其他 session 占用的 key（但保留自己的绑定）"
   - `/pool-status` — 按 provider 分组展示
   - `session_shutdown` — 遍历所有 provider 释放 + 清理 `PI_KEY_POOL_PROVIDER` env

2. `README.md` — 更新 Lifecycle 章节，新增"Provider Whitelist (key behavior change)"和"State Structure (.key-state)"两节；新增 Testing 章节

3. `CHANGELOG.md` — `[Unreleased]` 段记录 Changed/Fixed/Added

4. `tests/scenarios.bash.sh`（新）— 9 个 GWT 场景的集成测试
5. `tests/extract-script.mjs`（新）— 从 index.ts 提取 bash 脚本的辅助
6. `tests/logic.test.ts`（新）— 11 个 provider 分桶边界单元测试

**遇到的问题与解决方案**

1. **bash 脚本 available 列表计算错误**：第一版没排除"自己 session 的绑定"被 `taken` 检查误判为占用，导致 T2/T9/T10 全部返回 cooling 错误。修复：检查 `taken` 时增加 `sid != session_id` 排除。

2. **bash 脚本 available 列表没排除"其他 session 占用"**：第一版只过滤 cooled，没过滤已被别人占用的 key，导致 T3/T6 错误地选到别人已用的 key。修复：在 available 循环里增加"嵌套格式"和"老扁平格式"两层 taken 检查。

3. **测试 1-2 误用真实 `$HOME`**：提取脚本时没注意 `PI_KEY_POOL_DIR` 默认值是 `$HOME/.pi/agent/key-pool`，导致早期测试输出的是用户真实 key（`tp-cucc3...` 等），测试看上去"通过"但实际是在测真实环境。改为设置 `PI_KEY_POOL_DIR=/tmp/bash-test/key-pool` 隔离。

4. **awk 提取 TS 模板字符串丢了反斜杠转义**：用 `awk '/const GET_CURRENT_KEY_SCRIPT = `/,/^`;$/'` 提取时，`\${VAR}` 的反斜杠没被去掉（因为 awk 直接拿文件原文）。改用 Node mjs + `eval(\`...\`)` 正确求值 TS 模板字符串。

5. **TypeScript 编译错误**：`e: any` 引用 `e.message` 在 SessionEntry union 上不存在（原有 bug，不是本次引入）。运行时 OK，跳过。

**验证**

- 单元测试 `tests/logic.test.ts`：11/11 通过（bun）
- 集成测试 `tests/scenarios.bash.sh`：10/10 通过（bash + python3 + node）
- TS 编译：除原有 `e: any` bug 外无新增错误

**未完成 / 后续**

- TypeScript 编译时 `e: any` 的 SessionEntry 类型问题在 `retryLastUserMessage` 中遗留（不在本次 scope，未修）
- 真实 pi runtime 验证：用户需 `/reload` 后用 zai 模型触发 429，确认 key-pool 不再误接管（需要用户配合验证）

### 收口记录

**验收对照**

| 验收场景 | 实现位置 | 状态 |
|---------|---------|------|
| 场景 1：managed provider 失败正常切 key | `turn_end` provider 检查 + `switchProviderSessionKey` | ✅ 集成测试 T1 |
| 场景 2：非 managed provider 不接管（核心 bug） | `isManagedProvider` 白名单 + `turn_end` return | ✅ 单元 + 集成测试 T2 |
| 场景 3：session_start 不预先分配 | 删除 `assignKeyToSession` 调用 | ✅ 代码已删 |
| 场景 4：model_select 建立 provider 绑定 | `model_select` 钩子 | ✅ 集成测试 T1/T2 |
| 场景 5：multi-provider 并行 | provider 分桶 + `getProviderAssignments` | ✅ 集成测试 T4 |
| 场景 6：OAuth provider 自动跳过 | `isManagedProvider` 返回 false → `turn_end` return | ✅ 代码已实现 |
| 场景 7：autoConfigureModelsJson 注入全部 | 遍历 `providers` 集合 | ✅ 代码已实现 |
| 场景 8：state 文件迁移 | `loadStateUnlocked` + `cleanupStaleAssignments` 兼容读 | ✅ 集成测试 T5 |
| 场景 9：/pool-status 仍可读 | 按 provider 分组展示 | ✅ 代码已实现 |

**变更摘要**

- 单个 TypeScript 文件（`extensions/index.ts`）从 ~660 行扩到 ~860 行
- 1 个 bash 脚本字符串改造（~140 行）
- 2 个测试文件新增（~700 行）
- 文档：README +99 行、CHANGELOG +18 行

**回滚**：所有改动集中在 `extensions/index.ts` + 文档/测试，git revert 即可。运行时状态文件兼容老格式，升级无感。


# 发包记录

## 已发布：0.2.1

- 包名：`pi-key-pool`
- 版本：`0.2.1`
- 产物：`pi-key-pool-0.2.1.tgz`

### 校验信息

- shasum: `c482e42bb12e1996d476b93d4ef71a3e26bbe5d7`
- integrity: `sha512-Vg0OseL4PxoCRyfoWcU3pKYU9LeaEMwW32eBkyYHzW5Vv8HaDmH5IbGd4nUqIYmlwbmmbaxEeAUUSeFfsXnKrA==`

### 发包前检查

- `node --check extensions/index.ts` ✅
- `bash -n get-current-key.sh` ✅
- session assignment 脚本模拟输出 `KEY2` ✅
- `npm pack --dry-run --json` ✅
- `.doc/` 未进入 tarball ✅

### 产物内容

- `LICENSE`
- `README.md`
- `extensions/index.ts`
- `get-current-key.sh`
- `keys.example.json`
- `package.json`
- `pool-config.example.json`

## 待发布修补：0.2.2

- 目的：
  - 排除本地 `*.tgz` 产物，避免再次进入 npm tarball
  - 修正 `package.json` 的 `repository.url`，消除 publish warning
- 状态：已完成代码修改，待发布

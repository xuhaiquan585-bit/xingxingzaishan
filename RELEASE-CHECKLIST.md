# 🚀 xingxingzaishan 项目 — 发布前完整改进建议（修订版 v2）

> 综合来源：代码审查报告（6.5/10）、GitHub PR 评估（#15/#16）、人工评估、协作评审
> 项目当前状态：MVP 可运行，距离生产发布 **3 天（推荐稳妥节奏）**
> 文档版本：v2 — 融入协作评审意见（CORS 白名单化、限流增强、发布门禁、回滚演练）

---

## 一、总体判断

| 维度 | 当前状态 | 目标 |
|------|---------|------|
| 功能完成度 | ~78% | 95%+ |
| 安全基线 | ⚠️ 有明确漏洞 | 生产级 |
| 测试覆盖 | 主干 ~40% | 核心 >80% |
| 运维就绪 | 手动跑 | PM2+Nginx+日志轮转 |
| 上链集成 | 占位符/未实现 | 按业务排期 |

**结论：可以部署到服务器做内测/灰度，但开放公网访问前必须处理 P0 项。**

---

## 二、P0 — 发布前必须做（阻塞项，**不做不发**）

### P0-1 🔴 默认密码改造 + AUTH_SECRET 强校验

**现状风险：**
- `admin/admin123` 和 `qc/qc123456` 硬编码在初始化逻辑中
- `AUTH_SECRET` 默认值 `'dev-only-change-me'`，生产环境等于裸奔
- 部署文档已要求"发布前修改默认密码"，但无机制强制执行

**方案（两步走）：**

**第一步（立即做）— 环境变量注入 + fail fast：**
```javascript
// 启动时校验
if (process.env.NODE_ENV === 'production') {
  if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET === 'dev-only-change-me') {
    console.error('FATAL: AUTH_SECRET must be set and NOT use default value in production');
    process.exit(1);
  }
  if (!process.env.ADMIN_INIT_PASSWORD) {
    console.error('FATAL: ADMIN_INIT_PASSWORD is required in production');
    process.exit(1);
  }
  if (!process.env.QC_INIT_PASSWORD) {
    console.error('FATAL: QC_INIT_PASSWORD is required in production');
    process.exit(1);
  }
}
// 用环境变量的值替代硬编码密码
```

**第二步（后续迭代）— 首次登录强制改密：**
- 数据库加字段 `must_change_password: boolean`
- 首次登录后跳转改密页面，改完才放行

**预计工时：** 第一步 0.5 天 | 第二步 1 天

---

### P0-2 🔴 启动配置校验（fail fast）

**现状风险：**
- 已有 10+ 环境变量（OSS、AUTH、限流等），缺配时运行时报错而非启动时报错
- 容易出现"启动成功但功能异常"的假象
- **特别是 STORAGE_MODE=cloud 时 OSS 参数缺失应直接拒绝启动**

**方案：** 新增 `src/server/configValidator.js`

```
校验规则：
├── NODE_ENV=production 时必填：
│   ├── AUTH_SECRET 存在且 !== 'dev-only-change-me'
│   ├── AUTH_SECRET 长度 >= 32
│   ├── ADMIN_INIT_PASSWORD 已设置（>=8位）
│   └── QC_INIT_PASSWORD 已设置（>=8位）
├── OSS 相关（如果 STORAGE_MODE=cloud）：
│   ├── OSS_ACCESS_KEY_ID 存在 ── 缺失直接 process.exit(1)
│   ├── OSS_ACCESS_KEY_SECRET 存在
│   ├── OSS_BUCKET 存在
│   └── OSS_ENDPOINT 格式合法（URL 校验）
├── 可选配置给默认值：
│   ├── PORT → 默认 3000
│   ├── RATE_LIMIT_WINDOW_MS → 默认 60000
│   └── RATE_LIMIT_MAX → 默认 100
└── 启动时输出配置摘要（脱敏）：
    ✓ Port: 3000
    ✓ Storage: local (未配置 OSS)
    ✓ Mode: production
    ✓ Auth: configured (*** chars)
```

**调用方式：** 在 `app.js` 最顶部 `require('./configValidator').validate();`
**预计工时：** 0.5 天

---

### P0-3 🔴 补齐关键接口自动化测试

**现状：** 已覆盖用户登录、上传失败、参数校验、admin 登录/看板、qc 未授权、nft 下载

**需补测试（按优先级排序）：**

| # | 优先级 | 测试场景 | 对应路由 | 原因 |
|---|--------|---------|----------|------|
| 1 | **高** | admin 创建批次 | POST /api/admin/batches | 核心业务（当前缺失！）|
| 2 | **高** | admin 查询批次列表 | GET /api/admin/batches | 核心业务（当前缺失！）|
| 3 | **高** | admin 操作员管理 | POST/GET /api/admin/operators | 权限敏感 |
| 4 | **高** | qc 审核通过完整流 | PUT /api/qc/review/:id | 主业务路径（当前缺失！）|
| 5 | **高** | share-meta 接口 | GET /api/share/meta/:id | 用户可见入口（当前缺失！）|
| 6 | **高** | admin 访问 qc 接口 → 403 | PUT /api/qc/review/:id | 角色权限边界 |
| 7 | **高** | qc 访问 admin 接口 → 403 | GET /api/admin/batches | 角色权限边界 |
| 8 | **高** | 未登录访问需认证接口 → 401 | 多个路由 | 认证底线 |
| 9 | **中** | 边界错误码（超长输入/特殊字符） | 各路由 | 输入异常处理 |
| 10 | **中** | 并发上传 | POST /api/upload | 数据一致性 |

**目标：核心路由覆盖率从 ~40% 提升到 80%+**
**预计工时：** 1-2 天

---

### P0-4 🟠 上链决策（需要产品确认）

**现状：** README 明确标注"真实上链还没做"

**决策选项：**
- A) MVP 不承诺上链 → 保持占位接口，前端显示"上链中"模拟状态
- B) 承诺上链功能 → 排入迭代，预估 3-5 人天

**建议：** 内测/灰度先选 A，Phase 2 再接。
**预计工时：** A = 0 天 | B = 3-5 天

---

## 三、P1 — 本迭代内补（影响稳定性）

### P1-1 🟡 安全头 + CORS（**可配置白名单**）

**现状：** 未发现显式 CORS 配置和安全响应头

**方案（白名单化，通过 .env 配置）：**

```javascript
// src/server/middleware/securityHeaders.js
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',');

module.exports = (req, res, next) => {
  // CORS 白名单（通过环境变量 CORS_ORIGINS 配置，逗号分隔）
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  // 安全响应头
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy', "default-src 'self'");  // 基础策略
  next();
};
```

**关键点：** `CORS_ORIGINS` 通过 `.env` 配置，支持多域名（逗号分隔），灵活适配内测/生产环境切换。

**.env 示例：**
```bash
# 开发环境
CORS_ORIGINS=http://localhost:3000

# 生产环境（多域名）
CORS_ORIGINS=https://yourdomain.com,https://admin.yourdomain.com
```

**预计工时：** 0.5 天

---

### P1-2 🟡 登录限流增强（**在现有代码基础上增强**）

**现状：** 已有基础限流（内存 Map），但维度单一

**增强方向（不是从零做）：**

```
当前已有能力：
  ✅ 内存 Map 记录请求次数
  ✅ 基于 IP 的基础限制

增强为：
  ✅ IP + 手机号双维度限流（同账号换 IP 也拦）
  ✅ 响应头增加 Retry-After / X-RateLimit-Remaining（429 标准化响应）
  ✅ 可观测：日志记录触发限流的 IP/手机号（方便排查误伤）

后续优化（P2）：
  ⚠️ Map 过期清理（防内存泄漏，当前已知问题）
```

**预计工时：** 0.5 天（在现有 rateLimit 代码上增强）

---

### P1-3 🟡 审计日志按天切分

**现状：** 审计日志写入单个文件，无限增长

**方案：**
```javascript
// 按日期切分文件名
const logFile = path.join(logDir, `audit-${format(new Date(), 'yyyy-MM-dd')}.log`);

// 自动清理 >30天的日志文件（每次写入时异步检查）
async function cleanupOldLogs() { ... }
```

**效果：** `audit-2026-04-11.log`, `audit-2026-04-12.log`, ...
**预计工时：** 0.5 天

---

### P1-4 🟡 writeDB 并发保护（进程内串行锁）

**现状：** JSON 文件同步读写，并发请求可能导致数据损坏或丢失

**方案：** 加简单的写入队列（串行化）：

```javascript
// 写操作排队执行，避免并发写冲突
let writeQueue = Promise.resolve();
function writeDB(data) {
  writeQueue = writeQueue.then(() =>
    fs.writeFile(DB_PATH, JSON.stringify(data, null, 2))
  );
  return writeQueue;
}
```

**注意：** 这是单进程内的保护。如果未来用 PM2 cluster 模式，需升级为文件锁或迁移 SQLite。
**预计工时：** 0.5 天

---

## 四、P2 — 产品完善（不阻塞发布）

| 项目 | 说明 | 工时 |
|------|------|------|
| CI 流程 | GitHub Actions：每次 PR 自动跑 `npm test` | 1 天 |
| E2E 测试 | 注册→上传→点亮→下载/分享 最小回归链路 | 1-2 天 |
| `.env.example` | 提供模板防止漏配环境变量 | 0.1 天 |
| 限流 Map 清理 | 内存泄漏修复（过期 key 自动删除）| 0.2 天 |
| OSS 签名有效期 | 3600s → 900s 修正（与阿里云最佳实践对齐）| 0.1 天 |

---

## 五、🆕 发布门禁（Release Gate）

> **规定：以下条件全部满足才允许发版。任何一项不通过，禁止上线。**

### 自动检查（CI / 脚本）
- [ ] `npm test` 全绿（P0 测试用例 100% 通过，0 failures）
- [ ] `node configValidator.js` 通过（所有必填项已配）
- [ ] `AUTH_SECRET !== 'dev-only-change-me'`（脚本检测）
- [ ] lint 无 error
- [ ] 无合并冲突标记（<<<<<<<）

### 手动验证
- [ ] 默认密码已改为强密码（admin/qc 均确认）
- [ ] `.env` 文件权限 `chmod 600`
- [ ] 完整业务流程回归通过（注册 → 上传 → 审核(通过) → 下载/分享）
- [ ] HTTPS 可正常访问

### 门禁脚本建议
写一个 `scripts/pre-release-check.js`，一键跑上述自动检查项：
```bash
$ node scripts/pre-release-check.js
✓ AUTH_SECRET: OK (configured, not default)
✓ Config validation: passed
✓ Lint: no errors
✓ No merge conflicts
✓ Test suite: 42/42 passed
🎉 All checks passed! Ready to release.
```

---

## 六、🆕 回滚演练（Rollback Drill）

> **上线前一天必须做 dry-run，确保真出问题时能快速恢复**

### 方案 A（最快，<30 秒）
```bash
pm2 list                    # 查看版本历史和状态
pm2 restart xingxingzaishan --update-env  # 重启加载旧代码
# 或直接回退版本后重启
```

### 方案 B（稳妥，~2 分钟）
```bash
git revert HEAD            # 回退最近一次提交
git push origin main
# 服务器端执行：
git pull && pm2 restart all
```

### Dry-run 步骤（Day 3 下午执行）
1. 模拟故障场景（比如故意改坏一个配置）
2. 执行方案 A 回滚，计时
3. 验证服务恢复正常
4. 记录回滚耗时和注意事项
5. 团队确认谁有权执行回滚、通知谁

> ⚠️ 部署文档已有回滚说明，但**文档 ≠ 能力**——实际练一次才能真正确认流程通畅。

---

## 七、部署清单（上线当天用）

### 服务器准备
- [ ] 安装 Node.js 18+
- [ ] 克隆代码 `git clone` + `npm install --production`
- [ ] 创建 `.env` 文件并 `chmod 600`
- [ ] 生成随机 `AUTH_SECRET`（至少 32 位随机字符串）
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- [ ] 设置 `ADMIN_INIT_PASSWORD` / `QC_INIT_PASSWORD` 为强密码（>=12 位，含大小写+数字+特殊字符）
- [ ] 配置 `CORS_ORIGINS` 为你的前端域名（逗号分隔多域名）
- [ ] 配置 OSS 凭证（如果使用云存储，设 `STORAGE_MODE=cloud`）

### 进程管理
- [ ] 安装 PM2：`npm install -g pm2`
- [ ] 用 PM2 启动：`pm2 start src/server/app.js --name xingxingzaishan`
- [ ] 设置开机自启：`pm2 startup` + `pm2 save`
- [ ] 确认启动日志无 FATAL 错误

### 反向代理
- [ ] Nginx 配置反代（端口 3000 → 80/443）
- [ ] 申请 HTTPS 证书（Let's Encrypt 免费证书，certbot 一键申请）
- [ ] 验证安全头生效（浏览器 DevTools → Network → 查看响应头）

### 回滚准备
- [ ] **dry-run 回滚演练已完成**（Day 3 下午已执行）
- [ ] 回滚步骤文档在手边
- [ ] 团队成员知道谁有权执行回滚

### 上线验证（发布门禁最终确认）
- [ ] `node scripts/pre-release-check.js` 全绿 ✅
- [ ] 首页加载正常
- [ ] 用新密码登录 admin 后台 → 正常
- [ ] 用新密码登录 QC 审核 → 正常
- [ ] 完整业务流程通过：注册→上传→审核通过→下载/分享
- [ ] 审计日志正常记录（检查当天日志文件存在且有内容）
- [ ] `.env` 文件权限确认为 600
- [ ] HTTPS 访问正常，安全头存在

---

## 八、执行时间线（**修订版 v2 — 更稳妥的 3 天节奏**）

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  Day 1 — P0 核心安全改造                             │
│  ├─ 上午                                           │
│  │  ├─ 0.5h  写 .env.example 模板                  │
│  │  ├─ 0.5h  configValidator.js 启动校验            │
│  │  └─ 0.5h  环境变量注入初始密码                   │
│  ├─ 下午                                           │
│  │  ├─ 0.5h  securityHeaders 中间件（CORS白名单）   │
│  │  ├─ 0.5h  登录限流增强（IP+手机号双维度）        │
│  │  └─ 0.5h  本地跑全量测试确保无 regression        │
│  └─ 当晚                                          │
│     └─ 代码提交 + 推送                              │
│                                                     │
│  Day 2 — 补测试 + 回归                              │
│  ├─ 上午：补 10 个关键测试用例                      │
│  │  ├─ admin 批次 CRUD × 2                         │
│  │  ├─ 操作员管理 × 1                              │
│  │  ├─ qc 审核通过流 × 1                           │
│  │  ├─ share-meta × 1                              │
│  │  ├─ 权限边界（跨角色 403）× 3                    │
│  │  └─ 边界错误码 × 2                              │
│  ├─ 下午：                                        │
│  │  ├─ 跑全量测试，确保全绿                        │
│  │  ├─ 手动回归完整业务流程                        │
│  │  └─ 写 pre-release-check.js 门禁脚本            │
│  └─ 当晚：提交推送                                 │
│                                                     │
│  Day 3 — P1 快速项 + 部署上线                       │
│  ├─ 上午：                                        │
│  │  ├─ 0.5h  审计日志按天切分                       │
│  │  ├─ 0.5h  writeDB 串行队列锁                     │
│  │  └─ 代码提交推送                                │
│  ├─ 下午：部署                                    │
│  │  ├─ 1h    服务器环境搭建 + .env 配置             │
│  │  ├─ 0.5h  PM2 启动 + 验证                       │
│  │  ├─ 0.5h  Nginx + HTTPS                         │
│  │  └─ 0.5h  回滚演练 dry-run ★                   │
│  └─ 傍晚：                                       │
│     ├─ 跑发布门禁 pre-release-check                 │
│     ├─ 上线验证（逐项打勾）                         │
│     └─ 🎉 开放公网访问                             │
│                                                     │
│  后续持续（不影响发布）                              │
│  ├─ 监控线上运行                                   │
│  ├─ Phase 2：SQLite 迁移 / CI/CD / E2E / 上链      │
│  └─ 根据用户反馈迭代                                │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## 九、对比 v1 vs v2 变更点

| 变更项 | v1（原版） | v2（修订版） | 为什么改 |
|--------|-----------|-------------|---------|
| 时间线 | 1.5 天急行军 | **3 天稳妥节奏** | 降低返工概率，留缓冲 |
| CORS | 硬编码域名 | **可配置白名单（.env）** | 内测/生产域名切换更灵活 |
| 登录限流 | "从零做" | **在现有代码上增强** | 已有基础能力，不重复造轮子 |
| 发布门禁 | 无 | **新增 Release Gate** | 卡住不合格的发版 |
| 回滚演练 | 仅文档提及 | **新增 dry-run 要求** | 文档 ≠ 能力，实际练一次 |
| 测试粒度 | 7 个粗粒度 | **10 个细粒度（含权限边界）** | 更全面覆盖安全底线 |
| 配置校验 | 通用校验 | **强调 OSS cloud 模式 fail fast** | 云存储缺配是高频故障源 |

---

## 十、一句话总结（v2）

> **Day 1 搞安全，Day 2 补测试，Day 3 部署+回滚演练，然后放心发。发布门禁卡住不合格的，回滚能力保底出问题的。稳比快重要。**

---

*变更记录：*
*- v1 初稿（2026-04-11 13:12）— 基于 code-review-report.md + GitHub PR 评估*
*- v2 修订（2026-04-11 13:37）— 融入协作评审：CORS白名单化、限流增强、发布门禁、回滚演练、3天稳妥时间线*

# 星星在闪 - 第一阶段 MVP

## 启动方式

```bash
npm install
npm start
```

启动后访问：`http://localhost:3000`

运行自动化测试：

```bash
npm test
```

## MVP 测试步骤

1. 打开 `http://localhost:3000/record.html?qr=STAR0001`。
2. 首次会跳转注册页，输入 11 位手机号并勾选同意规则。
3. 回到记录页后上传一张图片，输入文字（可为空，最多 200 字）。
4. 点击“点亮这颗星”，按钮立即禁用，提交成功后进入结果展示。
5. 结果页应显示图片、文字、mock blockchain_hash 与时间。
6. 同一个二维码再次提交会提示“该星已被点亮，无法重复绑定。请确认二维码是否正确。”

## 第一阶段范围

- ✅ 用户主链路（扫码参数、注册、上传、结果页）
- ✅ mock blockchain_hash
- ✅ 二维码唯一绑定
- ✅ 统一 API 响应结构（status/code/message/data）
- ❌ 后台系统、质检系统、下载分享、真实上链


## Phase 2（进行中）- 后台管理批次 1

- 新增后台入口：`http://localhost:3000/admin`
- 默认管理员账号：`admin`
- 默认管理员密码：`admin123`
- 已实现：后台登录、看板、二维码列表筛选、隐藏/显示
- 后台新增：发行状态筛选、ID前缀搜索、批量勾选、批量隐藏/显示、批量CSV导出
- 后台新增：批次创建、批次绑定、批次筛选、批次CSV导出
- 后台新增：账号管理（新增/启用/禁用）
- 数据迁移：历史二维码默认补充 `batch_id: null`、`print_batch_id: null`
- 新增质检入口：`http://localhost:3000/qc`（账号：`qc` / 密码：`qc123456`）
- 用户端新增：NFT下载、分享链接（Web Share 优先，复制链接兜底）


## 覆盖版发布

如需将当前本地版本整体覆盖到 GitHub 目标分支，请参考：

- `docs/OVERWRITE_TO_GITHUB.md`


## 上传存储设计（含云存储缓冲）

当前上传链路已调整为“先缓冲，再入正式存储”模式：

1. 客户端上传图片到 `/api/upload`；
2. 服务端先把图片写入 `src/server/buffer/uploads` 作为缓冲；
3. 根据 `STORAGE_MODE` 决定正式存储位置：
   - `local`（默认）：写入 `src/server/public/uploads`，返回 `/uploads/<file>`；
   - `cloud`：写入本地 mock 云目录 `src/server/public/cloud`，返回 `/cloud/<file>`；
4. 若设置 `CLOUD_PUBLIC_BASE_URL`，cloud 模式会返回该公网前缀 URL（便于后续切到真实 OSS/S3/CDN）。

示例：

```bash
# 默认本地存储
npm start

# 开启 cloud 模式（本地 mock）
STORAGE_MODE=cloud npm start

# cloud 模式 + 公网访问前缀
STORAGE_MODE=cloud CLOUD_PUBLIC_BASE_URL=https://cdn.example.com/stars npm start
```


## 测试与验收清单（建议每次提测都执行）

### 用户主链路

- [ ] 扫码进入 `record.html?qr=...`，未登录时自动跳转注册页。
- [ ] 注册手机号成功后返回记录页。
- [ ] 上传图片成功，页面显示预览。
- [ ] 提交点亮成功，结果页展示图片、文案、hash、时间。
- [ ] 同一二维码重复提交，返回 `QR_ALREADY_ACTIVATED`。

### 后台管理链路

- [ ] admin 账号可登录后台并看到统计看板。
- [ ] 可创建批次、绑定二维码、导出批次 CSV。
- [ ] 可新增操作员并启用/禁用账号。

### 质检链路

- [ ] qc 账号可登录质检系统。
- [ ] 输入有效二维码可完成质检并写入日志。
- [ ] 输入无效二维码返回 `QR_NOT_FOUND`。

## 存储与部署说明（补充）

### 运行模式

- `STORAGE_MODE=local`：
  - 上传先进入缓冲目录 `src/server/buffer/uploads`；
  - 再写入 `src/server/public/uploads`；
  - 返回 `/uploads/<object_key>`。
- `STORAGE_MODE=cloud`：
  - 上传先进入缓冲目录 `src/server/buffer/uploads`；
  - 再写入真实 OSS（对象 key 默认 `stars/{qrId}/...`）；
  - 返回短期签名 URL（展示/下载）；
  - 可通过 `OSS_SIGNED_URL_EXPIRES`、`OSS_DOWNLOAD_SIGN_EXPIRES` 控制签名有效期。

### 生产环境建议

1. 保留“先缓冲再写正式存储”的流程，便于失败重试与审计。
2. 给缓冲目录设置定时清理（例如每天离峰清理超过 7 天的文件）。
3. 私有 Bucket 场景建议仅存储 `image_object_key`，展示/下载时动态签名，避免 URL 过期。

## API 错误码建议（当前实现）

- `INVALID_PHONE`：手机号格式不正确。
- `VALIDATION_ERROR`：通用参数校验失败（如缺少图片/内容超长/批次参数为空）。
- `UPLOAD_FAILED`：上传失败（空文件或类型不符合）。
- `QR_NOT_FOUND`：二维码不存在。
- `QR_ALREADY_ACTIVATED`：二维码已绑定，不可重复提交。
- `UNAUTHORIZED`：未登录或 token 无效。
- `FORBIDDEN`：角色权限不足。
- `INVALID_CREDENTIALS`：后台账号密码错误。
- `USERNAME_EXISTS`：新增操作员时账号已存在。
- `BATCH_NOT_FOUND` / `OPERATOR_NOT_FOUND`：目标实体不存在。

## 运维与接口文档

- `docs/test-plan.md`：测试执行与回归记录模板。
- `docs/deploy.md`：部署步骤、环境变量与发布前检查。
- `docs/api-errors.md`：错误码与 HTTP 状态说明。


### OSS 历史文件迁移

```bash
# 先预演，不写入
npm run migrate:oss:dry

# 正式迁移（本地 public/uploads -> OSS，并回写 image_object_key）
npm run migrate:oss
```

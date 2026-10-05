# 部署指南（P0）

## 1. 运行环境

- Node.js 18+
- npm 9+
- 可写磁盘目录（日志、临时缓冲）

## 2. 必备环境变量

- `PORT`：服务端口（默认 3000）
- `AUTH_SECRET`：JWT/HMAC 签名密钥（生产环境必须设置为高强度随机值）
- `AUTH_TOKEN_TTL_SECONDS`：token 有效期，默认 43200（12h）
- `STORAGE_MODE`：`local` 或 `cloud`
- `BASE_URL`：生产必须为站点 HTTPS 根地址，例如 `https://xingxingzaishan.top`；不得包含账号、路径、查询或片段，避免分享链接受请求 `Host` 影响或降级为 HTTP
- `CLOUD_PUBLIC_BASE_URL`：cloud 模式对象公网前缀（可选）
- `OSS_ACCESS_KEY_ID`：OSS 访问 Key ID（cloud 模式必填）
- `OSS_ACCESS_KEY_SECRET`：OSS 访问 Key Secret（cloud 模式必填）
- `OSS_BUCKET`：OSS Bucket 名称（cloud 模式必填）
- `OSS_REGION`：OSS 区域（cloud 模式必填）
- `OSS_ENDPOINT`：OSS Endpoint（cloud 模式必填）
- `OSS_OBJECT_PREFIX`：对象前缀，默认 `stars`
- `OSS_SIGNED_URL_EXPIRES`：图片展示签名有效期（秒），默认 3600
- `OSS_DOWNLOAD_SIGN_EXPIRES`：下载签名有效期（秒），默认 3600
- `CLOUD_FALLBACK_TO_LOCAL`：OSS 上传失败时是否回退本地存储（`true/false`）；生产环境必须保持非 `true`，禁止顾客内容在 OSS 故障时静默分叉到单机目录
- `RATE_LIMIT_LOGIN_WINDOW_MS`：登录限流窗口，默认 60000
- `RATE_LIMIT_LOGIN_MAX`：登录窗口内最大请求数，默认 20
- `RATE_LIMIT_WRITE_WINDOW_MS`：写操作限流窗口，默认 60000
- `RATE_LIMIT_WRITE_MAX`：写操作窗口内最大请求数，默认 120
- `CORS_ORIGINS`：允许跨域来源白名单，逗号分隔（如 `https://a.com,https://b.com`）
- `DB_FILE`：数据库 JSON 文件路径（可选）
- `AUDIT_LOG_DIR`：审计日志目录（可选）
- `AUDIT_LOG_MAX_BYTES`：单个审计日志文件上限（可选，默认 64 MiB）
- `AUDIT_LOG_BACKUP_COUNT`：保留的轮转文件数（可选，默认 7）

## 3. 启动

先在受保护且不提交 Git 的 `.env` 中配置至少以下三项：

```text
NODE_ENV=development
AUTH_SECRET=replace-with-independent-secret-at-least-32-bytes
UPLOAD_PROOF_SECRET=replace-with-another-secret-at-least-32-bytes
```

`AUTH_SECRET` 与 `UPLOAD_PROOF_SECRET` 不得相同。生产环境还必须满足本页其余生产配置要求。

```bash
npm install
npm test
npm start

# 本地历史文件迁移（建议先 dry-run）
npm run migrate:oss:dry
npm run migrate:oss
```

## 4. 发布前检查

1. `AUTH_SECRET` 已设置且不使用默认值。
2. 管理员默认密码已修改。
3. `STORAGE_MODE=cloud` 时上传与下载链接可用。
4. `audit.log` 可写；应用会在达到大小上限时自动轮转并限制保留份数。
5. 执行 `npm test` 全部通过。
6. 如需跨域访问，`CORS_ORIGINS` 已配置允许的域名白名单。
7. 执行 `npm run check:conflicts`，确保仓库内无冲突标记残留。

生产数据库定时备份每小时生成一套 PostgreSQL dump、JSON 快照和清单并上传 OSS。服务器本地只作为短期缓存，保留最近 48 次运行目录；调度日志保留最近 168 份。该清理不删除 OSS 中的备份对象，也不删除顾客图片源文件。远端备份保留期、RPO、RTO 和告警责任仍须按项目需求单独确认。

部署后可运行只读观察 runner，连续核对 readiness、PM2 状态、根分区水位、最近一次定时备份以及 PostgreSQL 存证队列。该 runner 不触发备份、不重启应用，也不调用 OSS、短信、支付或区块链服务：

```bash
sudo /usr/bin/bash scripts/database/run-system-acceptance-production-observation.sh --check
```

输出 `SYSTEM_ACCEPTANCE_PRODUCTION_OBSERVATION=COLLECTED` 表示只读采集完成；仍需结合 `OBJECT_MIRROR_P0_GATE`、队列计数和项目验收报告判断是否满足上线门槛，不能把“采集完成”解释成所有 P0/P1 已关闭。对象镜像门禁关闭还要求生产只写镜像和独立恢复审计都有时效内的成功证据。

## 5. 顾客对象独立镜像

数据库备份不包含顾客图片、缩略图、存证附件和打印成品的字节。生产上线前必须配置第二个私有 OSS Bucket，且同时满足：

- 与主 Bucket 名称不同；
- 位于不同地域；
- 归属于不同阿里云账号；
- 访问控制为 `private`；
- 版本控制为启用状态；
- 源凭据只有读取和 Bucket 信息权限；
- 生产端目标凭据只有 `PutObject` 和 Bucket 身份核对权限，不得读取、列举、删除对象或修改 Bucket；
- 独立恢复审计使用另一套只读凭据，只授予 `GetBucketInfo` 和 `GetObjectVersion`，不得持久保存在生产服务器。

目标凭据保存在 `/etc/xingxingzaishan/object-mirror.env`，文件必须是 `root:root`、权限 `0600`，内容使用以下键名：

```text
MIRROR_OSS_ENDPOINT=oss-cn-example.aliyuncs.com
MIRROR_OSS_REGION=oss-cn-example
MIRROR_OSS_BUCKET=replace-with-independent-private-bucket
MIRROR_OSS_ACCESS_KEY_ID=replace-with-dedicated-key-id
MIRROR_OSS_ACCESS_KEY_SECRET=replace-with-dedicated-key-secret
MIRROR_OSS_SECURE=true
```

镜像覆盖数据库引用的记录主图及缩略图、商品图、存证清单及证书、归档文件和打印成品。首次运行下载全部源对象并建立 SHA-256 清单；每次目标写入必须返回非 `null` 的 OSS 版本 ID，清单 v3 同时固定对象键、SHA-256、大小、ETag 和目标版本 ID。后续运行只在上一份本地受保护的 v3 清单与源对象 ETag/大小一致时复用原写入回执。生产端不读取目标对象；独立恢复审计必须按清单中的版本 ID 下载，不能以对象当前版本代替。

```bash
sudo /usr/bin/bash scripts/database/run-production-object-mirror.sh --preflight
sudo /usr/bin/bash scripts/database/run-production-object-mirror.sh --authorize-mirror-write=YES
sudo /usr/bin/bash scripts/database/install-production-object-mirror-systemd.sh
```

预检和正式运行会按应用相同的 dotenv 优先级重建当前 PM2 运行配置，并绑定 PID、启动时间和工作目录；配置文件在进程启动后变更会直接失败，避免镜像任务连接到与应用不同的数据库或 OSS。预检成功标记为 `PRODUCTION_OBJECT_MIRROR_RUNNER_PREFLIGHT=PASS`。正式镜像必须同时出现 `MIRROR_DESTINATION_OBJECT_READ=NONE`、`MIRROR_DESTINATION_VERSION_IDS=PINNED`、`MIRROR_WRITE_RECEIPTS_VERIFIED=YES`、`PRODUCTION_OBJECT_MIRROR_WRITE_ONLY=PASS` 和 `PRODUCTION_OBJECT_MIRROR_RUNNER=PASS`。

生产服务器只安装每日 03:20 的增量只写镜像任务。抽样恢复和每月全量恢复使用 `production-object-restore-audit-cli.js` 在独立环境执行，并显式提供受保护的 `AUDIT_OSS_*` 只读凭据、v3 镜像清单和审计输出目录。审计身份必须具备 `oss:GetObjectVersion`，但不得具备对象写入或删除权限。首次全量镜像只有在独立全量精确版本恢复出现 `MIRROR_FULL_RESTORE_AUDIT=PASS` 后才算验收完成；后续生产镜像证据不得超过 36 小时，独立全量恢复证据不得超过 35 天。

恢复校验下载的对象字节只存放在独立审计当次运行的临时目录中；无论成功、校验不一致或下载中断，临时字节都会删除。生产服务器本地只保留最近 45 次写入清单；超出部分在下一次成功运行后清理。目标 Bucket 中的完成清单不受本地保留策略影响。

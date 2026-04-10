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
- `CLOUD_PUBLIC_BASE_URL`：cloud 模式对象公网前缀（可选）
- `OSS_ACCESS_KEY_ID`：OSS 访问 Key ID（cloud 模式必填）
- `OSS_ACCESS_KEY_SECRET`：OSS 访问 Key Secret（cloud 模式必填）
- `OSS_BUCKET`：OSS Bucket 名称（cloud 模式必填）
- `OSS_REGION`：OSS 区域（cloud 模式必填）
- `OSS_ENDPOINT`：OSS Endpoint（cloud 模式必填）
- `OSS_OBJECT_PREFIX`：对象前缀，默认 `stars`
- `OSS_SIGNED_URL_EXPIRES`：图片展示签名有效期（秒），默认 3600
- `OSS_DOWNLOAD_SIGN_EXPIRES`：下载签名有效期（秒），默认 3600
- `CLOUD_FALLBACK_TO_LOCAL`：OSS 上传失败时是否回退本地存储（`true/false`）
- `RATE_LIMIT_LOGIN_WINDOW_MS`：登录限流窗口，默认 60000
- `RATE_LIMIT_LOGIN_MAX`：登录窗口内最大请求数，默认 20
- `RATE_LIMIT_WRITE_WINDOW_MS`：写操作限流窗口，默认 60000
- `RATE_LIMIT_WRITE_MAX`：写操作窗口内最大请求数，默认 120
- `DB_FILE`：数据库 JSON 文件路径（可选）
- `AUDIT_LOG_DIR`：审计日志目录（可选）

## 3. 启动

```bash
npm install
npm test
AUTH_SECRET='replace-with-strong-secret' npm start

# 本地历史文件迁移（建议先 dry-run）
npm run migrate:oss:dry
npm run migrate:oss
```

## 4. 发布前检查

1. `AUTH_SECRET` 已设置且不使用默认值。
2. 管理员默认密码已修改。
3. `STORAGE_MODE=cloud` 时上传与下载链接可用。
4. `audit.log` 可写并可轮转。
5. 执行 `npm test` 全部通过。

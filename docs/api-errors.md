# API 错误码说明（P0）

| code | HTTP | 说明 | 典型接口 |
|---|---:|---|---|
| INVALID_PHONE | 400 | 手机号格式错误 | `/api/user/login`, `/api/qr/:id/record` |
| VALIDATION_ERROR | 400 | 参数校验失败 | 多个写接口 |
| UPLOAD_FAILED | 400 | 上传失败（空文件/类型不支持） | `/api/upload` |
| QR_NOT_FOUND | 404 | 二维码不存在 | `/api/qr/:id`, `/api/qc/check` |
| QR_HIDDEN | 403 | 二维码被隐藏 | `/api/qr/:id` |
| QR_ALREADY_ACTIVATED | 409 | 二维码已点亮 | `/api/qr/:id/record` |
| UNAUTHORIZED | 401 | 未登录或 token 无效/过期 | `/api/admin/*`, `/api/qc/*` |
| FORBIDDEN | 403 | 权限不足 | `/api/admin/*`, `/api/qc/*` |
| INVALID_CREDENTIALS | 401 | 账号或密码错误 | `/api/admin/login` |
| USERNAME_EXISTS | 409 | 操作员账号重复 | `/api/admin/operators` |
| OPERATOR_NOT_FOUND | 404 | 操作员不存在 | `/api/admin/operators/:id/*` |
| BATCH_NOT_FOUND | 404 | 批次不存在 | `/api/admin/batches/*` |
| RATE_LIMITED | 429 | 请求触发限流 | 登录/写接口 |
| OSS_UPLOAD_FAILED | 502 | OSS 上传失败 | `/api/upload` |
| OSS_CONFIG_ERROR | 500 | OSS 配置不完整 | `/api/upload` |
| OSS_DEP_MISSING | 500 | OSS SDK 依赖缺失 | `/api/upload` |
| OSS_DOWNLOAD_SIGN_FAILED | 502 | OSS 下载签名失败 | `/api/nft/:qrId/download` |
| INTERNAL_ERROR | 500 | 服务器内部异常 | 全局 |

> 所有错误响应结构统一为：`{ status: 'error', code, message }`。

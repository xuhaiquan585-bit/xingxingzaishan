# 星星在闪 - 第一阶段 MVP

## 启动方式

```bash
npm install
npm start
```

启动后访问：`http://localhost:3000`

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


## 覆盖版发布

如需将当前本地版本整体覆盖到 GitHub 目标分支，请参考：

- `docs/OVERWRITE_TO_GITHUB.md`

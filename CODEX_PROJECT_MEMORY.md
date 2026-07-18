# 星星在闪 Codex 项目记忆

更新时间：2026-07-19

这个文件用于新开的 Codex 对话快速对齐项目背景、产品判断、技术边界和近期已做决策。新窗口接手前，建议先读本文件，再看当前代码和 `git status`，因为代码可能已经继续变化。

## 1. 项目定位

项目名：星星在闪

一句话定位：把一张照片和一句话，永久记在一瓶酒里；用户第一次扫码记录信息，之后再次扫码查看这瓶酒里的记录。

品牌口号：记在星上，闪到永远

商业方向不是“二维码系统”或“酒厂 SaaS”。当前决定是先销售“酒瓶星贴”（贴纸本身，不含酒水），让用户把星贴贴在自己的酒瓶或礼盒上完成记录；未来再扩展到销售“带星贴的酒”或“带星贴的礼盒酒”。

- 一枚酒瓶星贴对应一个二维码，用户把星贴贴在酒瓶或礼盒上。
- 用户扫码进入页面，上传照片并写一句话。
- 系统把内容保存为这枚星贴 / 这瓶酒的专属记录。
- 后续扫码同一个二维码，直接查看记录。
- 区块链存证是核心卖点，要帮助用户建立“永久保存、可验证、封存后不可篡改”的心智。
- 当前前台和小程序商品表达必须明确“酒瓶星贴，不含酒水”，避免用户误以为现在卖的是酒。

典型场景：

- 孩子成年礼存酒
- 婚礼、结婚纪念、生日、重要时刻
- 送礼时把祝福和照片一起存在酒里
- 一瓶酒不只是酒，而是承载一段可回看的记忆

当前产品形态已经从第一阶段 MVP 进入准产品化阶段：H5 记录链路、小程序用户端、后台运营、OSS 归档、AVATA / 文昌链存证、小程序订单和微信支付都已有代码落地。下一阶段重点不是继续盲目加功能，而是做真实设备验收、生产配置核对和核心体验收口。

## 2. 当前主流程

默认单人保存流程：

1. 用户第一次扫酒瓶二维码进入 `record.html`。
2. 未登录时跳到 `register.html` 验证手机号。
3. 验证后回到当前二维码记录页。
4. 用户上传照片、写一句话。
5. 用户选择保存方式：直接保存或邀请共创。
6. 直接保存时，进入预览确认弹层。
7. 确认后保存，生成这瓶酒的封存清单和区块链存证。
8. 成功页展示照片、留言、时间、凭证、品牌信息、分享和我的记录入口。
9. 后续扫码同一二维码，直接查看已保存结果，不再重新填写。

重要原则：

- 第一次扫码：记录信息。
- 后续扫码：查看信息。
- 已保存记录原则上不可修改。
- 手机号用于找回“我的记录”，文案不要让用户觉得是在注册账号。
- 成功页负责释放品牌感，前面的注册/填写/确认页优先降低理解成本。

## 3. 共创流程当前规则

共创是新增能力，用于同一瓶酒桌上的多人参与同一条记录。

入口：

- 填写页在照片和文字下方有保存方式：
  - 直接保存：按原流程立即封存。
  - 邀请共创：先保存为共创中，主事人邀请他人留言，最后由主事人确认封存。

共创中状态：

- `activation_status === "co_creating"`。
- 主事人能看到分享入口、确认封存入口、留言列表、删除留言按钮。
- 主事人不显示“留下你的见证”表单，因为主照片和主留言已经代表主事人内容。
- 被邀请人能看到共创内容和留言表单。
- 被邀请人不显示分享给朋友，也不能确认封存。

留言规则：

- 每条共创留言最多 50 字。
- 同一手机号在同一二维码下只能保留 1 条有效共创留言。
- 每瓶最多 12 条有效共创留言。
- 主事人删除某条留言后，该留言不再计入 12 条上限，也不算该手机号的有效留言。
- 第一版不支持参与者修改自己的留言；写错可由主事人删除后重新提交。

封存：

- 主事人点击“确认封存”时，使用项目内统一的品牌化确认弹层，不使用浏览器原生 `window.confirm()`。
- 弹层文案方向：
  - 标题：确认封存共创记录
  - 说明：封存后，这张照片、这句话和保留的共创留言，将生成这瓶酒的区块链永久记录。
  - 弱提示：以后扫码只能查看，不能修改。
  - 主按钮：确认封存
  - 次按钮：再检查一下
- 确认后调用现有 `/api/qr/:id/finalize`，成功后进入原成功页。

## 4. 当前页面文案方向

请以当前代码为准，但以下是已反复讨论后的文案方向。

注册页：

- 标题应围绕“把这一刻，记在这瓶酒里”。
- 副标题需要一句话讲清玩法，例如“这瓶酒可以永久保存一张照片和一句话，以后扫码随时查看”。
- 页面目的不是“注册账号”，而是验证手机号，方便以后找回记录。

填写页：

- 标题不必和注册页完全重复，当前方向偏向“留下这瓶酒的专属记录”。
- 副标题强调：选一张照片，写一句话，永久记在这瓶酒里。
- 上传标题：添加照片。
- 上传成功：已选择照片。
- 用户已上传照片后，原上传按钮切换为“更换照片”，下方不再额外出现第二个“更换照片”文字链接。
- 留言标题：写下想记住的话。
- 留言提示：最多 200 字。
- placeholder 方向：例：这一刻，我想记下的是……
- 品牌开关：显示酒的品牌信息。
- 主按钮：预览并确认。

确认页：

- 直接保存确认页必须说明不可修改和区块链永久记录。
- 当前方向：
  - 提交后，这张照片和这句话，将生成这瓶酒的区块链永久记录。
  - 以后扫码只能查看，不能修改。

成功页：

- 标题：保存成功。
- 副标题：记在星上，闪到永远。
- 默认不裸露完整 hash。
- 凭证按钮：查看区块链永久凭证。
- 展开后显示区块链凭证编号和完整 hash。
- 分享按钮优先 `navigator.share`，不支持时复制链接，不允许自动下载或 `window.open` 下载页。

记录详情页：

- 展示完整记录。
- 保存时间和区块链凭证应作为一组信息。
- 品牌露出和“星星在闪 · 记在星上，闪到永远”、二维码编号可以放在详情底部附近。

## 5. 技术结构

前端：静态 HTML + CSS + JS

后端：Node.js / Express

重点文件：

- `src/frontend/register.html`
- `src/frontend/js/register.js`
- `src/frontend/record.html`
- `src/frontend/js/record.js`
- `src/frontend/me.html`
- `src/frontend/js/me.js`
- `src/frontend/me-detail.html`
- `src/frontend/js/me-detail.js`
- `src/frontend/css/style.css`
- `src/frontend/js/api.js`
- `src/server/routes/user.js`
- `src/server/routes/qr.js`
- `src/server/routes/upload.js`
- `src/server/services/dbService.js`
- `src/server/services/userSessionService.js`
- `src/server/services/smsCodeService.js`
- `src/server/services/smsProviderService.js`
- `src/server/middlewares/userSession.js`

小程序 / 订单 / 存证相关重点文件：

- `src/miniprogram/app.json`
- `src/miniprogram/app.wxss`
- `src/miniprogram/pages/home/home.wxml`
- `src/miniprogram/pages/home/home.wxss`
- `src/miniprogram/pages/home/home.js`
- `src/miniprogram/pages/products/`
- `src/miniprogram/pages/product-detail/`
- `src/miniprogram/pages/order-confirm/`
- `src/miniprogram/pages/orders/`
- `src/miniprogram/pages/order-detail/`
- `src/miniprogram/utils/request.js`
- `src/miniprogram/utils/auth.js`
- `src/server/routes/miniapp.js`
- `src/server/routes/payment.js`
- `src/server/routes/chain.js`
- `src/server/services/manifestService.js`
- `src/server/services/chainProofService.js`
- `src/server/services/avataService.js`
- `src/server/services/archiveService.js`
- `src/server/services/wechatPayService.js`

二维码/管理相关文件：

- `src/server/routes/qr.js`
- `src/server/services/dbService.js`
- `src/admin/js/admin.js`
- `src/qc/js/qc.js`
- `tests/api.test.js`

## 6. 接口和数据边界

严禁随便修改：

- 后端接口路径
- 数据库结构
- 短信登录流程
- 上传/压缩/OSS 逻辑
- 二维码 URL / key / token 规则
- 已发行二维码的访问方式

当前关键接口：

- `GET /api/qr/:id`：查询二维码状态。
- `POST /api/qr/:id/record`：直接保存或发起共创。
- `POST /api/qr/:id/comments`：共创留言。
- `DELETE /api/qr/:id/comments/:commentId`：主事人删除共创留言。
- `POST /api/qr/:id/finalize`：主事人确认封存共创记录。
- `GET /api/user/records`：我的记录，已包含已封存记录 + 当前用户发起中的共创记录。
- `GET /api/miniapp/content`：小程序首页、项目说明、分享等内容配置。
- `GET /api/miniapp/products`、`GET /api/miniapp/products/:id`：小程序商品列表和详情。
- `POST /api/miniapp/orders`：小程序创建星贴订单。
- `GET /api/miniapp/orders`、`GET /api/miniapp/orders/:orderId`：小程序订单列表和详情。
- `POST /api/miniapp/orders/:orderId/pay`：小程序订单支付，优先微信 JSAPI；未配置时测试环境可走 mock。
- `POST /api/payment/wechat/notify`：微信支付回调。
- `POST /api/chain/avata/callback`：AVATA / 文昌链存证回调。
- `POST /api/admin/records/:qrId/chain/query`、`/retry`：后台手动查询和重试存证。
- `POST /api/admin/records/:qrId/archive/rebuild`：后台重建记录归档。

安全原则：

- `/api/qr/:id` 公开状态接口必须白名单返回字段。
- 不向前端泄露 `phone`、`co_creation_owner_phone`。
- `co_creating` 状态未登录时，不返回照片、文字、评论。
- `co_creating` 状态已登录时，返回共创页面所需内容、可见评论、`is_co_creation_owner`、`has_my_co_creation_comment`、`co_creation_comment_count`、`co_creation_comment_limit`。
- 已激活二维码当前产品逻辑是公开扫码可查看最终记录。

## 7. 已完成的重要能力

- 扫码进入记录页。
- 二维码状态判断：
  - 未激活：填写流程。
  - 共创中：共创管理/留言流程。
  - 已激活：结果查看页。
- 手机号短信验证码登录。
- session/cookie 强身份：后端通过 `req.user.phone` 识别当前用户。
- 上传图片，且上传失败不会误提交旧图。
- 直接保存和成功页展示。
- 我的记录页和详情页。
- 个人记录接口按 session 用户隔离。
- 上传接口登录鉴权。
- 个人页 XSS 已修复，用户内容不要用 `innerHTML` 拼接。
- 品牌展示字段注意 `brand_name`、`brand_disclosure_text`、`brand_disclosure_text_snapshot`，不要混乱。
- 成功页 hash 默认不裸露，点击后展开。
- 分享降级为复制链接。
- 共创流程：发起、留言、删除、最多 12 条、每人 1 条、主事人封存。
- “确认封存”已从浏览器原生弹窗改为项目内统一弹层。
- 已新增原生微信小程序用户端，目录为 `src/miniprogram/`，不使用 uni-app/Taro。
- 小程序用户端已包含：首页、项目说明、商品展示、商品详情、记录填写、共创、结果页、我的记录、记录详情、微信手机号授权。
- 小程序后端适配层已使用 `/api/miniapp/`，包含微信登录、手机号绑定、二维码查询/记录、上传、我的记录、商品、内容配置等接口。
- 小程序手机号绑定使用 `getPhoneNumber code` 方案，不使用废弃的 `encryptedData/iv`。
- 小程序扫码入口设计：瓶身二维码继续使用 `https://xingxingzaishan.top/record.html?t=token`，微信后台配置普通链接二维码跳小程序；其他软件扫码仍进入 H5。
- 商品一期当前聚焦销售酒瓶星贴，不含酒水；小程序星贴订单链路已落地：商品列表/详情、确认订单、我的订单、订单详情、后台订单列表和发货。
- 微信支付 V3 已接入小程序订单：支持 JSAPI 支付参数生成、微信支付回调验签/解密/标记支付成功，并支持微信支付公钥模式；未配置支付时测试环境保留 mock pay 能力。
- Admin 已做板块化：工作台 / 瓶码管理 / 记录管理 / 小程序内容 / 商品管理 / 账号权限 / 系统设置。
- Admin 已支持商品管理、小程序内容配置、订单查看和发货；交易管理仍不要扩成复杂电商后台，先服务“酒瓶星贴”实物订单。未来销售带星贴的酒/礼盒时，再扩展商品类型、履约和合规信息。
- 内容安全已封装小程序相关检测思路：开发/测试可 mock pass，生产缺微信配置时不能默默放行相关安全接口。
- 已接入 AVATA V3 / 文昌链哈希存证服务：支持签名、正式字段、提交、状态归一化、回调处理、后台查询/重试。
- 已新增封存清单 `record_manifest.json` 和归档能力：最终记录生成稳定 hash，归档到 OSS / 本地存储，并维护按星星 ID 的索引。
- 顾客侧链上状态已按产品口径收敛：展示“存证生成中 / 已完成区块链存证 / 存证暂未完成，系统会继续处理”，不直接暴露后台 operation_id、object_key、错误堆栈等。
- 小程序首页内容管理已增强：后台可配置首页标题、副标题、LOGO、Banner、轮播、场景卡、项目说明、品牌故事、分享文案。
- 小程序首页已做品牌叙事化改造：居中 Hero、沉浸式露边轮播、横向场景卡片流、底部信任背书，保留原有 `handleSlideAction`、`goSceneProducts`、`goProducts`、`scanCode` 等业务绑定。
- 小程序首页 LOGO 加载失败已加兜底：后台配置了不可访问图片时，前端自动退回默认星形品牌标识，避免出现空圆占位。
- H5 长文本换行已修复，避免用户留言/记忆内容撑破容器。

## 8. 视觉和 UX 决策

当前主视觉仍是深蓝品牌体系。不要突然改成大范围“温情极简主义”暖白展陈风格，除非用户明确要求整套视觉重构。

当前阶段最重要的是：

- 用户第一次扫码能明白正在做什么。
- 用户知道手机号是为了找回记录。
- 用户知道上传照片和写一句话就能完成。
- 用户知道提交/封存后不能修改。
- 用户知道区块链永久记录是核心价值。

不要做：

- 星空背景大改
- 拍立得风格
- 金色印章大改
- 证书风格大改
- html2canvas 海报生成
- 大范围 UI 重构
- 花哨动画
- 未提到的顺手优化

可以做的小修：

- 文案更清楚。
- 层级更清晰。
- 按钮和提示风格统一。
- 隐藏原生控件瑕疵。
- 保持手机端可读、可点、不重叠。

### 8.1 小程序视觉统一规则（2026-06-02）

小程序当前名称先使用“记在星上”。“星星在闪”仍是项目/品牌背景，但小程序顶部和当前用户端体验以“记在星上”为准，后续商标结果出来后再决定是否统一调整。

小程序用户端已形成一套页面语言，后续改其他页面优先沿用：

- 深蓝星空背景：深蓝线性渐变 + 低透明径向光晕。
- 前景卡片：`rgba(255,255,255,.04)` 半透明玻璃底、极细白色边框、`20rpx` 圆角、轻阴影、`backdrop-filter: blur(16px)`。
- 主色：香槟金 `#d4af37` / `#e4c46e`，只用于主按钮、标题重点、选中态、凭证感元素。
- 不要大面积使用亮黄、重金色、厚实深色块、胶囊标签堆叠。
- 主按钮使用香槟金，阴影收敛，不做刺眼外发光。
- 次按钮使用透明玻璃风格。
- 所有页面注意 `env(safe-area-inset-bottom)`，避免按钮或提示被 iOS Home Bar 遮挡。
- 用户输入/记忆内容可使用 `"Songti SC", STSong, serif`，编号/hash/计数使用等宽字体。
- UI 文字保持无衬线体系。

记录填写页是当前最重要的视觉标杆。当前头部顺序锁定为：

```text
把这一刻，记在这瓶酒里
选一张照片，写一句话，以后随时能看到。
✦ 区块链存证
```

这个顺序的意图：

- 第一行建立情绪和场景。
- 第二行解释用户要做什么。
- 第三行把区块链作为低声量可信背书，不抢主视觉。

记录页当前关键 UX 决策：

- 上传框只显示 `+` 和“添加照片”，不要恢复多余小字说明。
- 上传后使用 `aspectFit` + 动态高度，优先完整展示照片，不裁切用户照片。
- 保存方式文案保持“直接保存 / 邀请共创”，不要在填写阶段改成“直接封存”，避免心理压力过高。
- 品牌露出开关保留在提交按钮上方，仅当有品牌露出文案时显示。
- 底部弱提示当前为“保存后，扫码即可查看这条记录。”。

最近做过一轮“不改文案”的小程序视觉统一：

- 全局 `app.wxss` 统一深蓝星空背景、玻璃卡片、按钮、输入、图片、标题/副标题层级和安全区。
- 结果页、记录详情页升级为更像纪念凭证页的视觉，但保留原有文案和业务入口。
- 共创页升级主记录、留言输入和留言列表质感，保留分享、确认封存、提交留言、删除留言绑定。
- 首页、项目说明、商品列表、商品详情、我的记录、微信授权页只做样式统一，不改文案、不改接口、不改 JS 业务逻辑。

### 8.2 小程序首页叙事化改造（2026-07-19）

首页已经从“工具型罗列”改成更偏品牌叙事的体验，重点文件是 `src/miniprogram/pages/home/home.wxml`、`src/miniprogram/pages/home/home.wxss`、`src/miniprogram/pages/home/home.js`。

当前首页方向：

- 顶部 Hero 居中，LOGO 缩小，弱化功能堆叠，突出首页标题和副标题。
- 页面背景使用深蓝径向星空，带轻微 `star-pulse` 呼吸动效。
- Swiper 高度已增大到 `640rpx`，使用 `previous-margin="40rpx"` 和 `next-margin="40rpx"` 做露边卡片效果。
- 轮播按钮改为半透明玻璃 + 香槟金边框，不使用大块实色按钮压住海报。
- 场景区从竖向长列表改为横向 `scroll-view` 卡片流，卡片宽度约 `480rpx`，减少纵向占屏。
- 底部信任背书改为 3 个精简图标式信息：区块链存证、不可篡改、封存后可查看。
- 顾客侧首页不要出现 `OSS`、`operation_id`、`manifest_object_key` 等后台技术词；底部文案当前为“内容妥善保存，凭证可验证。”。
- 首页必须保留“酒瓶星贴 / 一张照片 / 一句话 / 封存这一刻 / 已有星贴，扫码记录 / 区块链存证 / 不可篡改 / 封存后可查看”等核心认知信号。
- 首页 LOGO 使用 `logo_image`，图片加载失败时触发 `onLogoError`，退回默认品牌星形标识。
- 如果后台上传 LOGO 后小程序仍不显示，优先排查微信小程序 `downloadFile` 合法域名和 OSS 图片公开访问；不是每张图片单独设置，而是按域名设置。

首页后续优化必须保护这些绑定：

- `bindtap="handleSlideAction"`
- `catchtap="handleSlideAction"`
- `bindtap="goProducts"`
- `bindtap="scanCode"`
- `bindtap="goSceneProducts"`
- `binderror="onLogoError"`

非常重要：小程序 UI 改造必须先保护业务绑定，再改视觉壳子。重点绑定包括：

- `bindtap="chooseImage"`
- `bindinput="onContentInput"`
- `radio-group bindchange="onModeChange"`
- `checkbox-group bindchange="onBrandDisclosureChange"`
- `bindtap="submitRecord"`
- `open-type="share"`
- `bindtap="goMe"`
- `bindtap="submitComment"`
- `bindtap="finalize"`
- `bindtap="deleteComment"`
- `bindtap="copyBuyLink"`
- `open-type="getPhoneNumber"`

后续继续优化页面时，优先顺序建议：

1. 结果页：强化“价值证明”和分享后的高级感。
2. 共创页：强化邀请朋友参与的温和感和留言仪式感。
3. 首页 + 项目说明：解释项目，不要做成普通功能菜单。
4. 商品列表/详情：当前重点是酒瓶星贴销售，必须明确“不含酒水”；未来再扩展到带星贴的酒/礼盒。
5. 我的记录/记录详情：做成个人记忆档案。
6. 微信授权页：保持单行按钮和授权理由清楚。

## 9. 品牌区规则

品牌区可以显示，但必须防止空内容和占位内容影响正式体验。

显示条件：

- `show_brand_disclosure === true`
- 且后台返回的品牌文案 `brand_disclosure_text` 或 snapshot 字段 `trim()` 后非空

如果为空、`null`、`undefined`、仅空格：

- 不渲染品牌区，或完全隐藏。
- 不留空白区域。
- 不显示任何占位文案。

不要依赖 `brand_disclosure_default` 单独决定显隐。

正式体验中不要显示测试占位文案，如“品牌名称填这里”“品牌露出填这里”，除非后台真实写入。

## 10. 待讨论风险点

小程序记录填写页当前存在一个重要 UX 风险：`预览并确认` 主按钮在一屏内不一定能完整露出，用户可能需要下翻才能看到最终动作。

下次需要重点讨论两条方案：

- 底部悬浮操作区：把 `预览并确认` 做成固定在底部安全区上方的悬浮按钮，优点是行动入口始终可见，风险是可能压缩内容和遮挡底部表单。
- 缩短首屏内容：压缩标题、上传区、表单间距或组件高度，让关键内容尽量在一个屏内完成，优点是页面更整体，风险是可能牺牲当前的高级感和呼吸感。

判断标准：首屏必须保持门面质感，但最终动作不能藏得太深；优先考虑真实小程序设备上的可见高度，不只看开发者工具截图。

## 11. 二维码视觉方案讨论记录

讨论过“星星在闪”品牌化二维码：保留标准二维码核心，在外层增加圆形、放射状、星光装饰，形成“放射状星光二维码”。

原则：

- 不替换现有方形二维码默认逻辑。
- 不修改二维码 URL/key/token。
- 不删除或中断已发行二维码。
- 可新增 `square` / `radiant` 可选输出。
- 核心二维码必须保持 quiet zone、高对比、不遮挡定位点。
- 不复制微信小程序码官方样式或官方图标。

这个方向适合后续酒瓶印刷物料，但不要在未明确任务时贸然改当前二维码生成逻辑。

## 12. 区块链存证新方向（2026-07-01）

已决定放弃“至信链 / NFT凭证”方向，改为：

```text
阿里云 OSS 保存内容，文昌链 / AVATA 保存哈希存证。
```

核心原则：

- 图片和文字原文不直接上链。
- 图片、文字、共创留言、品牌露出等组成最终 `record_manifest.json`，保存到 OSS。
- 后端计算 `manifest_hash`。
- 文昌链只保存 `manifest_hash`、星星ID、封存时间、版本号等必要存证信息。
- 对外表达使用“区块链存证 / 链上存证 / 存证哈希”，不再使用“NFT凭证”作为当前用户可见卖点。
- 不要说“图片和文字全部写入区块链”。
- 不要把酒叫“区块链地址”。酒瓶唯一身份仍叫“星星ID”或“瓶码ID”。

推荐对外解释：

```text
OSS 存内容，文昌链存证据。
这条记录已生成链上存证，可验证封存后内容未被篡改。
```

AVATA / 文昌链接入当前状态：

- AVATA V3 接入代码已落地，包含签名、请求体构造、结果归一化、提交、查询、回调和错误处理。
- 已支持用一条最终记录生成 `manifest_hash`，再提交 AVATA / 文昌链存证。
- AVATA 上链是异步流程，要保存唯一 `operation_id`，避免重复上链和重复扣费。
- 回调和主动查询都要支持。
- 直接保存：内容安全检测通过后生成最终 manifest，上链一次。
- 邀请共创：发起和留言过程不上链，发起人最终封存时只上链一次最终 manifest。
- 正式生产前仍要核对 AVATA 认证、项目 ID、主体信息、回调地址、环境变量和真实扣费策略；不要直接把未验证配置压到正式主流程。

### 12.2 当前存证 / 归档实现（2026-07-19）

当前代码已经形成以下链路：

- `manifestService` 生成最终 `record_manifest_v1`，并用稳定序列化计算 `manifest_hash`。
- `archiveService` 把封存清单和索引写入 OSS / 本地存储，索引路径包含 `indexes/by-star/{star_id}.json`。
- `chainProofService` 负责准备 manifest、提交 AVATA、保存状态、查询、重试、处理回调和证书快照。
- `avataService` 负责 AVATA V3 配置、签名、请求、mock/真实提交分支和返回结果归一化。
- `dbService` 已扩展链上字段：`chain_status`、`chain_operation_id`、`manifest_hash`、`manifest_object_key`、`tx_hash`、`block_height`、`chain_record_id`、`certificate_url`、`retry_count`、`last_error`、`callback_received_at` 等。
- 后台工作台已有存证统计：待存证、存证中、存证成功、存证失败。
- 后台记录管理已有单条记录存证查询、重试和归档重建入口。
- 系统设置里可查看存储、微信小程序、内容安全、链上存证、归档等配置状态；不暴露密钥。

### 12.1 顾客侧和后台侧必须分开

这是后续接文昌链时必须遵守的产品原则：

```text
后台看“链上流程是否正常”。
顾客看“我的记忆是否被认真封存”。
```

顾客侧是“纪念凭证”，不能把后台技术细节直接丢给用户。

顾客侧最多展示：

- 照片
- 文字
- 星星ID
- 封存时间
- 区块链存证状态
- 存证哈希（可折叠或部分展示）
- 存证编号 / 证书链接（如果文昌链返回）
- 查看/复制凭证

顾客侧状态文案建议：

- `存证生成中`
- `已完成区块链存证`
- `存证暂未完成，系统会继续处理`

顾客侧不要展示：

- OSS object_key
- manifest_object_key
- operation_id
- API 返回原文
- 失败堆栈
- 回调日志
- 复杂状态枚举

后台侧是“存证运维面板”，必须准确、可追踪、可操作。

后台侧需要展示：

- 存证状态：未开始 / 生成中 / 已确认 / 失败
- `operation_id`
- `manifest_hash`
- `manifest_object_key`
- `tx_hash`
- `block_height`
- `chain_record_id`
- `certificate_url`
- `chain_provider`
- `retry_count`
- `last_error`
- `confirmed_at`
- `callback_received_at`
- 手动查询
- 手动重试

状态映射建议：

- 后端真实状态：`not_started / manifest_ready / submitting / submitted / confirmed / failed / retrying`
- 顾客看到：
  - `not_started / manifest_ready / submitting / submitted / retrying` → `存证生成中`
  - `confirmed` → `已完成区块链存证`
  - `failed` → `存证暂未完成，系统会继续处理`

后台不需要大改版，先在现有板块扩展：

- 记录管理：单条记录存证状态、凭证信息、重试/查询。
- 工作台：待存证、存证中、成功、失败统计。
- 系统设置：文昌链配置状态、环境、回调地址、OSS 状态；不显示 API Secret。

如果未来存证量很大，再单独拆“存证管理”板块。

## 13. 测试和运行

常用检查：

```powershell
node --check src/frontend/js/record.js
node --check src/frontend/js/me.js
node --check src/server/routes/qr.js
node --check src/server/services/dbService.js
npm test
```

本地运行需要环境变量。之前本地启动遇到过 `CONFIG_VALIDATION_FAILED`，通常是因为缺少 `AUTH_SECRET` / 管理员初始化配置等必需配置。

测试目前主要是：

```powershell
npm test
```

最近已通过的测试规模：`tests/api.test.js`，58 个测试通过。最近一次本地执行 `npm test` 通过时间：2026-07-19。

当前测试覆盖已经包括：

- AVATA V3 签名、存证请求体、结果归一化。
- manifest 稳定 hash，且不包含手机号 / openid 等身份秘密。
- H5 登录、短信、上传、二维码 token、直接保存、共创、我的记录、XSS 基础保护。
- Admin 登录、仪表盘、二维码批次、商品管理、小程序内容、系统状态、订单发货、链上/归档状态不泄露密钥。
- 小程序微信登录、手机号绑定、上传记录、共创、商品、订单、微信支付 JSAPI 参数、支付回调验签/解密、金额不匹配拒绝。

## 14. Git 和协作注意事项

GitHub 仓库：

```text
https://github.com/xuhaiquan585-bit/xingxingzaishan
```

近期重要提交：

- `5dfa059 Refine miniapp home storytelling layout`
- `ccc6525 Handle miniapp logo load failure`
- `7e90be3 Improve miniapp home content management`
- `732076f Support WeChat Pay public key mode`
- `b77f813 Add WeChat Pay V3 for miniapp orders`
- `4ddcc81 Add miniapp wine sticker orders`
- `33d001a Fix H5 long text wrapping`
- `35f4b18 Fix H5 memory input wrapping`
- `5feb9b0 Archive records to OSS and refine H5 display`
- `a224621 Add AVATA V3 chain proof integration`
- `8bcdcd7 Add miniapp seal-time scene recommendations`
- `8174fab Restructure miniapp home content`
- `68cffeb Polish miniapp entry pages`
- `ff431f5 Add co-creation record flow`
- `9ec6345 Tighten co-creation comment flow`
- `8a35a90 Use branded finalize confirmation modal`
- `8b2a2bd Refine miniapp record first impression`
- `7a8cf04 Polish miniapp record page spacing`
- `4213131 Tighten miniapp record helper copy`
- `9ded4ae Add glass treatment to miniapp record page`
- `35f1416 Improve miniapp record first screen`
- `6f98fe5 Refine miniapp record input layout`
- `41d622b Refine miniapp record trust line`
- `adaaeb1 Unify miniapp visual style`

工作前一定先看：

```powershell
git status -sb
git diff --stat
```

可能存在用户或其他进程留下的未提交修改。不要随便 revert，不要 `git reset --hard`。只提交本次任务明确相关的文件。

## 15. 新对话接手建议

每次新窗口开始时：

1. 先读本文件。
2. 再看当前 `git status -sb`。
3. 如果要改前端主流程，先读 `record.html`、`record.js`、`style.css`。
4. 如果要改共创/状态/安全，先读 `src/server/routes/qr.js` 和 `src/server/services/dbService.js`。
5. 如果要改“我的记录”，先读 `me.html`、`me.js`、`me-detail.html`、`me-detail.js`。
6. 如果要改小程序首页，先读 `src/miniprogram/pages/home/home.wxml`、`home.wxss`、`home.js`，保护首页轮播、扫码、商品、场景跳转和 LOGO 错误兜底绑定。
7. 如果要改小程序商品/订单/支付，先读 `src/miniprogram/pages/products/`、`product-detail/`、`order-confirm/`、`orders/`、`order-detail/`、`src/server/routes/miniapp.js`、`src/server/routes/payment.js`、`src/server/services/wechatPayService.js`。
8. 如果要改区块链存证/归档，先读 `src/server/services/manifestService.js`、`archiveService.js`、`chainProofService.js`、`avataService.js`、`src/server/routes/chain.js`，并区分顾客侧纪念凭证和后台侧运维细节。
9. 对 UI 文案改动要小步收口，不要一口气做大视觉重构，除非用户明确要求某个页面重构。
10. 对后端、数据库、上传、短信、二维码 token、支付回调、链上存证状态机的改动必须先讨论清楚。

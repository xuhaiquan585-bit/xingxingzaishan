# 覆盖版发布说明（以当前 `work` 分支为准）

> 目标：将当前仓库的最新实现直接覆盖到 GitHub 目标分支。

## 1. 前置确认

- 当前工作目录：`/workspace/xingxingzaishan`
- 当前分支：`work`
- 覆盖策略：以本地 `work` 分支代码为最终版本

## 2. 建议命令（安全）

```bash
# 查看当前状态
git status

# 绑定远端（如尚未绑定）
git remote add origin <你的仓库地址>

# 获取远端最新
git fetch origin

# 先在本地备份远端目标分支（可选但建议）
git branch backup-before-overwrite origin/main

# 强制覆盖推送（推荐 --force-with-lease）
git push origin work:main --force-with-lease
```

> 如果目标不是 `main`，将 `main` 替换成目标分支名。

## 3. 验证

推送后在 GitHub 检查：

- `src/frontend` 主链路页面是否存在
- `src/server` API 路由是否存在
- `src/admin` 后台页面与脚本是否存在
- `README.md` 是否包含 Phase 1 与 Phase 2（批次1）说明

## 4. 回滚（如需）

如果覆盖后需要回退：

```bash
# 切回备份并推送
# 假设你有 backup-before-overwrite 这个分支
git push origin backup-before-overwrite:main --force-with-lease
```


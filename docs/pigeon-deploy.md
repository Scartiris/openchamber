# Pigeon 发版与并行协作

> 适用于宿主机 `pigeon`（Debian 13, Docker 29.1.3）上的 `openchamber` 容器。

## 发版流（CI 出镜像 → 服务器拉）

```
本地 worktree 修改 → merge 到 custom → push origin custom
                 → GitHub Actions .github/workflows/docker.yml
                 → ghcr.io/scartiris/openchamber:custom / :custom-<sha>
                 → 宿主机: ./scripts/pigeon-deploy.sh pull custom && ./scripts/pigeon-deploy.sh switch custom-<sha>
```

打版本时：

```bash
node scripts/bump-version.mjs 1.20.107   # 同步 5 个 package.json
git add -A && git commit -m "release: v1.20.107"
git push origin custom
git tag v1.20.107 && git push origin v1.20.107   # 产出 ghcr.io/scartiris/openchamber:1.20.107
# 宿主机切版本
./scripts/pigeon-deploy.sh switch 1.20.107
```

`release.yml`（Electron）与 `docker.yml` 互不干扰；后者 `permissions: packages: write` 负责推送 GHCR。

## 服务器操作

在宿主机 `/root/projects/openchamber` 执行：

```bash
./scripts/pigeon-deploy.sh status            # 看当前镜像/历史
./scripts/pigeon-deploy.sh pull custom       # 拉最新 custom
./scripts/pigeon-deploy.sh switch 1.20.107   # 切到版本（自动改 docker-compose.pigeon.yaml 的 image + pull_policy）
./scripts/pigeon-deploy.sh rollback          # 回到上一版本
./scripts/pigeon-deploy.sh login             # 私有包时用 GHCR_TOKEN 登录
```

- 镜像以 `ghcr.io/scartiris/openchamber` 为前缀，`pull_policy: always`（`pigeon-deploy.sh switch` 自动切换）。
- 切换会备份 `docker-compose.pigeon.yaml.bak.<ts>` 并等待 `http://127.0.0.1:3000/health` 最多 60s，失败自动回滚。
- 保留最近 20 条 `.deploy-history`，`rollback` 取倒数第二条。

## 并行隔离（worktree）

```bash
./scripts/pigeon-worktree.sh new tts-fix          # 创建 ~/worktrees/tts-fix (branch feat/tts-fix from custom)
./scripts/pigeon-worktree.sh ls
# ... 在 ~/worktrees/tts-fix 里改代码、提交 ...
cd ~/openchamber-fork
git merge --no-ff feat/tts-fix && git push origin custom   # 触发 GHCR 构建
./scripts/pigeon-worktree.sh rm tts-fix           # 清理 worktree（检查未提交）
```

规则：`~/openchamber-fork` 常驻 `custom` 且保持干净；所有功能在 worktree 分支完成。

## 镜像瘦身

- 旧 `pigeon-openchamber:pre-repair/token-refresh` 为 `docker commit` 产物，顶层 6.7GB 无指令层导致 13.7GB。后续一律 `docker build`，预期 4.3–5GB（与官方 `openchamber-openchamber:latest` 对齐）。
- `.dockerignore` 已排除 `packages/web.bak-*`, `workspaces`, `data` 等。
- `Dockerfile` 首行注明禁止 `commit`。

## 旧备份

- 容器内 `~/packages/web.bak-*`（5 个）为历史手工备份，首个 GHCR 版本验证通过后删除，保留 git tag 回滚。
- 宿主机 `/root/backups/openchamber/20260826-095900-pre-repair/persistent-volumes.tar.gz` 为全量卷备份，保留至 1.20.107 稳定运行后归档。

## 常见问题

- **GHCR 私有拉取 401**：宿主机 `export GHCR_TOKEN=ghp_xxx && ./scripts/pigeon-deploy.sh login`，token 需 `read:packages`。
- **自己更新自己**：不要在容器内执行 `docker compose up -d`；只 `git push`，切换在宿主机执行。

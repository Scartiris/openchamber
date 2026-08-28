# Pigeon 发版与并行协作

生产镜像只从 `custom` 分支的 GitHub Actions 构建并推送到 GHCR；运行容器不再构建、提交或重启自己。

## 并行修改

```bash
./scripts/pigeon-worktree.sh new <task>
# 在 ~/worktrees/<task> 修改、验证、提交
cd /root/projects/openchamber-release
git merge --no-ff feat/<task>
git push origin custom
```

`custom` 的每次推送产出 `ghcr.io/scartiris/openchamber:custom` 与不可变的 `custom-<sha>` 标签；版本标签 `v1.20.x` 额外产出 `1.20.x`。

## 宿主机部署

将已验证的 `scripts/pigeon-deploy.sh` 安装到 `/root/projects/openchamber/scripts/` 后，仅在宿主机运行：

```bash
./scripts/pigeon-deploy.sh status
./scripts/pigeon-deploy.sh pull custom-<sha>
./scripts/pigeon-deploy.sh switch custom-<sha>
./scripts/pigeon-deploy.sh rollback
```

脚本显式拉取镜像、将 Compose 保持为 `pull_policy: never`，并通过 `openchamber-container.service` 完成重启。它会验证主站、记忆、节点网格与 OpenList 四个健康端点；任一失败即恢复原 Compose 文件和原镜像。

不要从容器内运行部署脚本。容器内只允许代码提交和 `git push`；切换由宿主机 systemd 接管，因此不会杀死发版会话。

## 持久化运行时

宿主机 Compose 必须保留以下绑定挂载：

```yaml
- ./data/openchamber/pigeon-data:/home/openchamber/.pigeon
- ./data/pigeon-runtime/node-mesh:/home/openchamber/node-mesh
- ./data/pigeon-runtime/apps:/home/openchamber/apps
```

记忆服务的数据和代码位于第一个目录；镜像入口会在容器启动时拉起它。卷快照应在每次切流前保留，旧镜像只在新版本稳定验证后再清理。

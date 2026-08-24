# Fork 升级 SOP（custom 分支维护指南）

- 上游：https://github.com/openchamber/openchamber
- Fork：https://github.com/Scartiris/openchamber
- 分支约定：
  - `main` = 镜像上游，不放任何定制
  - `custom` = 全部定制（zh-CN 汉化、Windows-only 发布流水线、更新源指向 fork）

## 桌面端更新通道

- Windows 客户端自动更新源 = `Scartiris/openchamber` 的 Releases（改于 `packages/electron/updater-feed.mjs`）
- 两台 PC（赤峰家里 / 单位）装过 fork 包后即永久走此通道
- **版本号策略**：patch 位从 100 起步（v1.20.100 → v1.21.100 …），保证高于同版官方且不带 `-` 后缀
  （带 `-` 会被 electron-updater 当 prerelease 过滤；客户端 allowPrerelease=false）

## 发新桌面版流程（UI 功能上线走这里）

```bash
cd /home/openchamber/openchamber-fork
git checkout custom

# 0. 若要跟上游：先按下方"日常升级流程"同步并 rebase

# 1. bump 版本（三处必须一致，CI 有校验）
sed -i 's/"version": "1.20.X"/"version": "1.20.Y"/' \
  package.json packages/electron/package.json packages/web/package.json

# 2. CHANGELOG.md 顶部加 "## [1.20.Y] - 日期" 段（create-release 会校验存在）

# 3. 提交推送 —— 千万确认推的是 custom！（曾因忘 push 导致构建旧代码）
git add -A && git commit -m "release: v1.20.Y" && git push origin custom
git log --oneline -1   # 核对 HEAD 就是刚提交的

# 4. tag + 推送
git tag v1.20.Y && git push origin v1.20.Y

# 5. ⚠️ fork 上 tag push 不会自动触发 workflow，必须手动 dispatch：
curl -s -X POST -H "Authorization: token $(cat ~/.config/openchamber/github-token)" \
  https://api.github.com/repos/Scartiris/openchamber/actions/workflows/release.yml/dispatches \
  -d '{"ref":"custom","inputs":{"version":"1.20.Y","dry_run":"false"}}'

# 6. 等 CI（约 8 分钟）：https://github.com/Scartiris/openchamber/actions
#    成功后 release 自动 publish（exe + blockmap + latest.yml）
#    若重发过同名版本，去 release 页删掉旧版本残留资产（如 1.20.0 exe）
```

## 日常升级流程（跟上游代码）

```bash
cd /home/openchamber/openchamber-fork

# 1. 同步上游（含新 tag）
git checkout main
git fetch upstream --tags
git merge --ff-only upstream/main
git push origin main

# 2. rebase 定制分支到新 tag
git checkout custom
git rebase v1.2X.0   # 用最新 tag；或 rebase upstream/main 跟开发版

# 3. 冲突处理
#    高发点: packages/ui/src/lib/i18n/messages/zh-CN*.ts（上游也常改词典）
#    解完冲突后:
git add -A && git rebase --continue

# 4. 构建验证
bun install
bun run build:web
grep -c "管理 opencode 插件" packages/web/dist/assets/zh-CN-*.js  # 汉化抽查

# 5. 推送 + 部署
git push --force-with-lease origin custom   # rebase 后需要 force

mv /home/openchamber/packages/web /home/openchamber/packages/web.bak-prev
cp -a packages/web /home/openchamber/packages/web

# 6. 重启容器（注意：会把本容器内运行的会话一起重启）
curl -s -X POST --unix-socket /var/run/docker.sock http://localhost/containers/openchamber/restart

# 7. 验证
curl -s -m 5 http://127.0.0.1:3000/api/health        # Authentication required 即在线
curl -s -m 3 http://127.0.0.1:3210/health            # pigeon-memory 自动拉起

# 回滚: mv packages/web.bak-prev packages/web 后再执行第 6 步
```

## 环境备忘

| 项 | 值 |
|---|---|
| 凭据 | `/home/openchamber/.config/openchamber/git-credentials` (600) |
| 本地仓库 | `/home/openchamber/openchamber-fork` |
| 部署目录 | `/home/openchamber/packages/web` |
| 备份 | `/home/openchamber/packages/web.bak-pre-v1.20.0`（切换前快照） |
| 汉化源 | `/home/openchamber/.config/openchamber/i18n/i18n.patch`（已进 custom 分支） |
| 容器 | `openchamber`（docker.sock 可用，容器内无 docker CLI） |

## 注意事项

1. **Windows Electron 客户端不归 fork 管**：桌面端仍是官方包，汉化 patch 流程照旧
   （Electron 更新后重跑 `python C:\Users\admin\.config\openchamber\i18n\patch_home.py`）
2. rebase 尽量在无活跃会话时做；重启容器会中断容器内所有会话
3. token 建议定期轮换为 fine-grained（只留 Contents:RW）

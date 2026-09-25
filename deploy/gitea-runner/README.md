# Gitea Runner (act_runner) 部署说明

本目录提供了在 Docker 中运行 Gitea CI/CD Runner 的完整配置。
该 Runner 挂载了宿主机的 `/var/run/docker.sock`，因此在工作流触发时，能够直接在宿主机的 Docker 中构建并运行新的容器。

---

## 快速启动步骤

### 第一步：获取 Gitea Runner 注册 Token
1. 登录 Gitea（例如你的实例：`http://kongfu-onedrive.kooka-salmon.ts.net:23000`）。
2. 进入当前仓库（或组织）：
   - 点击 **仓库设置 (Settings)** -> **Actions** -> **Runners**。
   - 点击右上角 **Create Runner**（创建 Runner）。
   - 复制弹出的 **Registration Token**。

### 第二步：一键运行部署向导
在目标服务器上运行：
```bash
cd deploy/gitea-runner
./setup.sh
```
根据提示粘贴 Token，脚本会自动生成 `.env` 并启动 `gitea-runner` 容器。

*(或者手动复制 `.env.example` 为 `.env`，填入 Token 后执行 `docker compose up -d`)*

---

## 自动部署验证
1. 打开 Gitea 仓库后台 **Actions -> Runners**，确认名为 `realtime-chopper-runner` 的 Runner 状态为绿色的就绪状态。
2. 在本地提交或推送代码到 `dev` 分支：
   ```bash
   git checkout dev
   git commit -am "test dev deploy"
   git push origin dev
   ```
3. 在 Gitea 仓库的 **Actions** 标签页即可实时查看自动构建与 Docker 部署日志！

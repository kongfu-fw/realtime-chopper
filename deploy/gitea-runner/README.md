# Gitea Runner 部署与触发说明

本配置支持 **自动触发** 与 **手动触发** 两种部署模式。

---

## 触发方式说明

### 模式一：自动触发（代码更新自动部署）
- **触发条件**：向 `dev` 分支提交或推送代码（`git push origin dev`）。
- **运行流程**：Gitea 检测到 `dev` 分支有变动，通知 Runner 自动拉取最新代码，重新构建 Docker 镜像，优雅替换容器并做健康检查。

### 模式二：手动触发（按需一键部署）

#### 方式 1：通过 Gitea 网页界面一键触发 (workflow_dispatch)
1. 打开 Gitea 仓库后台，点击顶部 **Actions (操作)** 标签页。
2. 在左侧列表中选择 **Deploy Dev to Docker**。
3. 点击页面右上角的 **Run workflow (运行工作流)** 蓝色按钮。
4. 在弹出的表单中可自定义配置：
   - **部署目标分支**：默认 `dev`（可输入其它分支或 tag）
   - **容器映射端口**：默认 `8080`
   - **强制无缓存重新构建**：是否开启 `--no-cache`
5. 点击提交，Runner 立即开始执行部署。

> [!TIP]
> **关于 Gitea 手动触发按钮的特别提示**：
> Gitea/GitHub 规范要求：手动触发按钮 (`workflow_dispatch`) 只在工作流文件存在于仓库**默认分支**（通常为 `main`）时，才会在 Actions 列表中显示该工作流的“运行”按钮。
> 因此，将 `.gitea/` 目录合并到 `main` 分支（或在仓库设置中将默认分支设为 `dev`）后，网页端即可正常看到并点击手动触发按钮。

#### 方式 2：在服务器终端直接手动执行
如果通过 SSH 登录了服务器，也可以在项目目录下直接运行部署脚本，无需经过 Git 推送：
```bash
# 默认部署 (端口 8080)
./deploy/deploy.sh

# 自定义端口部署 (例如 9000 端口)
RC_PORT=9000 ./deploy/deploy.sh

# 强制不使用缓存重新构建
NO_CACHE=true ./deploy/deploy.sh
```

---

## Runner 初始化说明

如果服务器尚未启动 Gitea Runner：
1. Gitea 仓库设置 -> **Actions** -> **Runners** -> **Create Runner**，复制 Registration Token。
2. 在服务器上运行：
   ```bash
   cd deploy/gitea-runner
   ./setup.sh
   ```
   输入 Token 即可一键在 Docker 启动 Runner 并关联到 Gitea。

# 发布与安装（GitHub / npm）

面向维护者的发布清单。命令在仓库根目录执行：

```powershell
cd C:\Users\Bolin\Desktop\DSH\codex-link
```

## 0. 发布前自检

```powershell
node --test test          # 单元测试（应全绿）
node tools/check.mjs      # 静态检查
node scripts/integration.mjs --protocol-only   # 真实 Codex 本地协议自检（可选）
npm pack --dry-run        # 看会发布的文件清单与体积
```

确认：

- `package.json` 的 `version` 是本次要发的版本；
- `CHANGELOG.md` 已写本次变更；
- `repository` / `homepage` / `bugs` 已改成真实 GitHub 地址（把 `<YOUR_GITHUB_NAME>` 换掉）；
- `npm view dsh-plugin-codex-link version` 返回 404 说明包名可用（返回版本号说明已被占用）；
- 已登录 npm：`npm login` 后 `npm whoami` 返回用户名。

## 1. 发 GitHub

1. 打开 https://github.com/new 新建仓库，名称建议 `dsh-plugin-codex-link`，**不要**勾选自动生成 README（本地已有内容）。
2. 本地关联并推送：

```powershell
git remote add origin https://github.com/<YOUR_GITHUB_NAME>/dsh-plugin-codex-link.git
git branch -M main
git push -u origin main
git tag -a v0.2.2 -m "v0.2.2"
git push origin v0.2.2
```

3. 可选：在仓库页加上 About 描述、Topics（`dsh`、`dsh-plugin`、`deepseek-harness`、`codex`），并在 Releases 页把 tag `v0.2.2` 发布为 Release。

## 2. 发 npm

1. 登录（浏览器或 OTP）：

```powershell
npm login
npm whoami
```

2. 关联仓库元数据（把用户名替换为真实值，一次即可）：

```powershell
npm pkg set repository.type=git `
  repository.url=git+https://github.com/<YOUR_GITHUB_NAME>/dsh-plugin-codex-link.git `
  homepage=https://github.com/<YOUR_GITHUB_NAME>/dsh-plugin-codex-link#readme `
  bugs.url=https://github.com/<YOUR_GITHUB_NAME>/dsh-plugin-codex-link/issues
```

3. 发布：

```powershell
npm publish --access public
```

- 开了两步验证会提示输入 OTP；
- 包名已被占用时，改用 scope：`npm pkg set name=@<YOUR_NPM_NAME>/dsh-plugin-codex-link`，再 `npm publish --access public`。

4. 验证：

```powershell
npm view dsh-plugin-codex-link version dist.tarball
npm view dsh-plugin-codex-link files
```

## 3. 让别人安装

DSH CLI / Web（把包装进 profile）：

```powershell
dsh plugin --profile web add dsh-plugin-codex-link
```

DSH 桌面端：Plugins 页 → 安装 → 输入包名 `dsh-plugin-codex-link` → 重启/重载。

从 GitHub 直接装：

```powershell
dsh plugin --profile web add "github:<YOUR_GITHUB_NAME>/dsh-plugin-codex-link#v0.2.2"
```

安装后：设置 → **Codex 联动** 面板选择操作方式；Codex 侧不需要装任何插件，只需已安装并登录 Codex CLI。

## 4. 后续版本

```powershell
# 改代码、补 CHANGELOG
npm version patch   # 或 minor / major：改 version + git commit + 打 tag
git push --follow-tags
npm publish
```

如果不想让 `npm version` 自动提交，可手改 `version`，再：

```powershell
git add -A; git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push --follow-tags
npm publish
```

## 5. 安全与注意事项

- 不要把 `.npmrc`、npm token 提交进仓库；发布用 `npm login` 的本地凭据或 CI 的 `NPM_TOKEN` secret。
- 开启 npm 两步验证（2FA），避免 token 泄漏后被发版。
- `files` 已限定发布内容（`lib/`、`client.js`、`cordis.patch.yml`、README、CHANGELOG、LICENSE），测试/脚本/内部文档不会进包。
- 版本不可覆盖：npm 一旦发布同一版本号就不能重发，只能发新版本。
- 若仓库公开，确认 LICENSE（MIT）与第三方参考说明（见 `CHANGELOG.md`）保持准确。

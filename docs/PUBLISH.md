# 安全发布到 GitHub

## 哪些能上传

只使用 `npm run release:pack` 生成的源码 ZIP。里面只有 `scripts/release-policy.mjs` 明确列出的通用文件，另附哈希清单。不要直接上传原来的工作盘，也不要把配置成功后的 runtime 当源码上传。

包体没有 node_modules、可执行文件、模型、知识库、真实聊天、身份档案、工程输入输出或 Git 历史。用户通过 `npm ci --ignore-scripts` 安装依赖，通过文档自行配置。

## 许可证

本包新增通用接口代码使用 Apache-2.0，允许修改、分发、商用，并含贡献者专利授权条款。保留 LICENSE、NOTICE 和第三方声明；修改和再分发时遵守许可证条款。它不要求公开与本接口独立的商业执行器。

MIT 也适合小接口包且更简单；这里按希望明确专利授权和分发规则的用途选择 Apache-2.0。依赖包的 MIT/BSD/Apache 等许可仍各自有效。未获授权的第三方核心和工程不能因为外层加了 Apache 就公开；若以后引入其他项目源码，须保留其版权与原许可并重新核查兼容性。

## 发布前检查

```sh
npm ci --ignore-scripts
npm test
npm audit --omit=dev --audit-level=high
npm run release:check
npm run release:pack
```

可选私有词扫描，PowerShell：

```powershell
$env:RELEASE_PRIVATE_TERMS_FILE = (Resolve-Path .\privacy.private.json).Path
npm run release:check
npm run release:pack
```

`privacy.private.json` 不进 ZIP，不提交。检查失败只输出相对文件名和规则，不回显匹配到的密钥。

本项目是唯一发布入口。ZIP 固定输出到项目内的 `release/ketupa-agent-feishu-bridge.zip`，旁边有 `.sha256` 和 `PUBLIC_MANIFEST.json`。每次覆盖同名发布包，真实版本记录在 package.json 与清单里。release 已被 Git 忽略；源码包也不包含 release，避免重复嵌套和误提交验证资料。一般无需指定其他产物目录。

压缩包只用文件白名单生成；文件时间统一，避免暴露本机修改时间。总源码限制 2 MiB、单文件 512 KiB，通常远小于这个限制。

每次打包都会重置 `release/VALIDATION.json` 并写入新包哈希，测试状态为 null，避免沿用旧包的通过报告。打包本身只扫描源码；必须针对同一哈希完成测试、依赖审计和解压校验后，才能记录验收结果。

## 建立干净仓库

1. 把最终 ZIP 解压到新的空目录。**这个解压目录才是 Git 仓库根**。
2. 检查 README、LICENSE、docs/PUBLIC_MANIFEST.json；再次运行 tests 和 release:check。
3. 只在这个根目录运行：

```sh
git init
git config user.name "<愿意公开的维护者名称>"
git config user.email "<GitHub 提供的 noreply 邮箱>"
git config core.hooksPath .githooks
git add .
git update-index --chmod=+x .githooks/pre-commit
node scripts/release-check.mjs --staged
node scripts/release-check.mjs --tracked
git diff --cached --stat
```

4. 用自己的公开名和 noreply 邮箱替换占位符；只设置本仓库，不更改 global。Git 提交作者信息也会公开，不能只检查文件正文。审核确认只包含接口源码后自己提交，再在 GitHub 创建空仓库并设置 remote。remote 必须是你自己选择的地址；包内作者页仅有维护者明确授权的公开联系方式和主页，不附带私人工程名、实际运行账号、既有仓库配置或历史提交。
5. `git push` 是发布动作，自动配置 AI 不应未经明确授权执行。本包未自动向外网上传任何文件。

CI 会在 push/pull request 后运行安装、测试、依赖审计和全部 Git 索引检查，无需配置任何真实密钥。提交钩子同样检查全部索引，拒绝未知文件、符号链接与子模块；默认 release:check 在本项目有 .git 时也会检查索引。Actions 使用固定提交 SHA，checkout 不保留凭据，工作流只有 contents:read 权限。具体检查与剩余限制见 [安全体检](SECURITY_REVIEW.md)。GitHub 仓库 Topics 可选：

```text
feishu lark codex openai-compatible agent feishu-workspace task-dispatch automation privacy apache-2-0
```

## 真实验收不要跳步

自动测试覆盖模拟消息、模型协议、权限隔离、文件落盘、任务交接和输出交付；这不等于真实平台授权、外部模型额度或实际仿真完成。依次做文档中的私聊、上下文、非敏感附件、demo、真实执行器验证，并分别记录证据。

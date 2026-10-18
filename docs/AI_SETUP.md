# 交给 AI 的配置指令

**触发关键词：配置飞书本机接口**

复制下面整段，附上你解压后的目录路径；不附密钥。

```text
配置飞书本机接口。

工作根目录：<我指定的本项目目录>。
先读 README.md、docs/CONFIGURE.md、SECURITY.md 和两个 workspace 的 README。

只在指定目录配置这三个模块：bridge、feishu-workspace、ketupa-workspace。
禁止扫描其他个人目录、聊天库、工程、知识库或业务核心；不要复用已有账号身份或服务配置。
安装依赖用 npm ci --ignore-scripts。运行 npm run init，不覆盖已有本地配置。
密钥只由我在本机 config/.env 填入；不要向我索要粘贴到聊天，不要打印、上传或复制凭据。
用新建测试机器人做 pair，建立最小用户和会话白名单；空名单必须拒绝访问。
让我选择 Codex CLI 或兼容 API，核对真实型号和协议，不能猜型号。
是否把会话文本发给云端需要我明确同意；附件和其他资料不得默认上传模型。
保持同一用户、同一聊天的上下文，不把所有用户共享到一个模型会话。
先跑 npm test、doctor，再按配置手册完成 hello、附件落盘、demo 任务和 output 交付验证。
启用知识前读 docs/KNOWLEDGE.md，只用我显式授权的 Markdown/TXT，建立逐文档哈希与双 ACL；不默认上传已有知识库。
自然语言任务先 /plan 生成受 schema 约束的预览，核对缺项与文件编号，再 /submit；模型不能提供执行命令。
用 /tasks、/status、/cancel 验证后台调度，检查重投不重复提交，重启不重复执行已 claim 的任务。
按 docs/OPERATIONS.md 配置隐藏后台服务和恢复；不要反复打开终端或并行启动同一应用。
不要把 mock 或 demo 当作真实模型、平台权限或仿真成功；每一步写明实际证据和未完成项。
真实任务执行器只通过固定配置的 workflow 接入，参数写 JSON，不把用户或模型的文字拼进 shell。
只交付当前任务 output 内的文件，拒绝路径逃逸、符号链接和跨用户取文件。
业务核心、工程、执行器、许可证服务由我另外提供，不从个人工作盘自动复制。
发布前运行 npm run release:check 和 npm run release:pack，只检查/上传白名单源码。
若当前目录已是本项目的 Git 仓库根，额外运行 node scripts/release-check.mjs --tracked，检查所有已加入索引的文件；未知文件和链接必须拒绝。
打包只更新 release 中固定名称的发布包；不要另建平行发布目录，不要把 release 提交到 Git。
不要执行 git push、发布或给他人发送消息；没有明确授权时不要操作外部账号。
能由本机配置完成的步骤直接做，只在缺少关键输入、账号授权或外部发布前询问。
```

这段指令是操作约束，不是系统权限隔离。需要强边界时，使用独立账号、容器或受限文件挂载，且不要挂载私人核心目录。

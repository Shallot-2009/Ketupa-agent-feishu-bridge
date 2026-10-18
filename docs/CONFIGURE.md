# 从零配置

## 1. 准备独立目录

解压公开源码包到一个新目录。不要把整个个人工作盘初始化为公开仓库；不要复用正在服务的机器人、Codex home 或私人配置。安装 Node.js 22.19 或更新的 LTS。

```sh
node --version
npm ci --ignore-scripts
npm run init
```

生成 `config/.env` 和 `config/settings.local.json`，重复 init 不覆盖已有值。源码目录无需包含任何个人资料。

## 2. 创建飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，用自己的账号创建企业自建应用，添加“机器人”能力。应用所属租户必须与你要测试的账号匹配。
2. 在凭证页取得 App ID、App Secret，**只填入本机 `config/.env`**：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`。不要写进示例、README 或提交记录。
3. 在事件与回调中选择**长连接接收事件**，添加 `im.message.receive_v1`。长连接无需公网回调地址。
4. 按平台实际展示的权限说明，申请私聊接收 `im:message.p2p_msg:readonly`、机器人发送 `im:message:send_as_bot`、资源读写 `im:resource`。群聊按需加 `im:message.group_at_msg:readonly`；希望存储未 @ 的群附件时，需要接收普通群消息的相应权限，例如 `im:message.group_msg`。权限是否可开通取决于租户政策；本包不能替代管理员批准。
5. 发布应用版本、设置可用范围，让测试账号可以找到机器人。平台调整权限名称时以后台说明和 [接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive) 为准。

Lark 用户在 `config/settings.local.json` 中将 `feishu.domain` 改为 `lark`，对应使用 [Lark 开放平台](https://open.larksuite.com/app)。

## 3. 一次性绑定私聊

```sh
npm run pair
```

终端生成有效期三分钟的配对字符串。用自己的测试账号在机器人私聊发送完整字符串。成功后本机的 `allowedUsers`、`allowedChats` 自动填充，终端不会打印身份 ID。配对结束后重新启动正式服务。

默认空白名单拒绝所有消息；不能把它改成“任何人可访问”。群聊需要同时配置允许的用户和群 chat_id；ID 应从自己的应用事件调试或合法 API 获取。群消息默认需 @；附件可以在授权群内单独发送，但机器人必须实际收到附件事件才能保存。不能从其他应用搬用资源 token。

## 4. 选择一个模型入口

### A. Codex CLI

安装并在本机用自己的账号完成 Codex 登录。参考 [官方安装与认证](https://developers.openai.com/codex/cli) 和 [非交互执行](https://developers.openai.com/codex/noninteractive)。本项目使用 `codex exec --json` 和 `codex exec resume <thread-id>`，不是每条消息新建会话。

```sh
codex --version
codex login
```

`config/settings.local.json` 的 `model.provider` 保持 `codex`。`model.name` 为空时沿用所选 Codex home 的默认模型；填值时必须是自己服务真实支持的型号。可用模型和额度由账号/服务决定，本项目不做固定承诺。

如需独立 `CODEX_HOME`，在 `config/.env` 填本机路径，**先在同一环境运行 Codex 登录**，再启动本服务。不要复制他人的 `auth.json`；不要把认证目录放入公开仓库。

Windows 自动查找原生 `codex.exe` 或官方 npm 安装的 `codex.js`。不能找到时，在 `model.command` 配置：

```json
{
  "file": "node",
  "args": ["<本机官方安装目录>/bin/codex.js"]
}
```

把占位符替换为真实安装路径，仅保存在 `config/settings.local.json`。不运行 `.cmd`、`.bat`、PowerShell 字符串，也不启用 danger-full-access。

### B. OpenAI 兼容 API

在 `config/.env` 本机填写：

```dotenv
MODEL_BASE_URL=https://api.example.com/v1
MODEL_API_KEY=
```

将地址和空密钥改为自己服务提供的值；在 `config/settings.local.json` 设置：

```json
{
  "provider": "openai-compatible",
  "name": "<服务真实支持的模型名>",
  "sendChatToModel": true,
  "maxHistoryMessages": 16,
  "maxOutputTokens": 500
}
```

将这些字段合并到 `model` 节，**不要用此片段替换完整配置**。服务须支持 `/chat/completions`；仅有 Responses 或厂商专有接口的服务需另写适配器，不能假定任何 API 都兼容。云端必须使用 HTTPS；仅本机回环服务允许 HTTP。不把第三方密钥填进飞书后台，模型调用来自自己的本机程序。

## 5. 明确文本授权

在 `model` 中设 `sendChatToModel: true`，表示你同意授权会话的文字历史发送给配置的模型服务。默认 false。附件只保存本地，不自动读取其正文发给模型。`/plan` 会将当前会话附件名称、编号和参数 schema 发给模型选择输入，不发送附件正文或执行器路径。不导入身份资料、其他账号记录或现有工程。知识启用需另行逐文件授权。

默认读写目录位于两个模块的 `runtime` 下；也可在本机配置中改到两个独立的私人目录。禁止两个 runtime 重叠或覆盖代码目录。

## 6. 检查和启动

```sh
npm run doctor
npm run doctor -- --live
npm start
```

普通 doctor 检查配置、白名单和 CLI 可执行性；`--live` 另外验证飞书应用凭证与机器人身份接口，输出 `feishuAuth`、`feishuBot` 布尔值。它不启动长连接、不发消息，不等于事件订阅、模型推理或附件交付验收。原始平台错误、身份 ID 和密钥不打印。

`feishuAuth=false`：核对本机配置的应用凭证、平台区域、网络；不要把密钥发到聊天。`feishuAuth=true` 而 `feishuBot=false`：核对机器人能力、应用发布状态和机器人信息接口访问。两项都通过后仍需检查第 2 步的事件订阅、权限、可用范围，再做下方真实入站测试。

在机器人私聊依次验证：

1. 发“你好”，确认真实回复；继续发“我刚说了什么”，检查上下文。
2. 发送不敏感的 `sample.txt`，再发 `/files`，确认落盘且有编号。
3. 发 `/task demo example {}`。复制返回的任务 ID，发 `/run 任务ID`。
4. 发 `/result 任务ID`，应只收到 output 中的 `result.json`，文件明确标为 demo。

如果同一类型有多个历史附件，提交时明确选择：

```text
/task demo example {"files":{"source":"<来自 /files 的编号>"},"params":{"message":"hello"}}
```

不要用私人 PCB 或客户资料作第一次测试。

## 7. 接入真实任务引擎

详见 [ketupa-workspace](../ketupa-workspace/README.md)。先在独立测试环境验证执行器；再注册固定 command、输入类型和参数 schema。公开包不含真实求解命令、网表模板或算法，demo 成功只能证明接口流转。

## 8. 日常运行

`npm start` 前台运行，Ctrl+C 停止。可交给系统服务管理器；本包不自动安装自启、修改注册表或登录其他平台。隐藏运行和恢复见 [运维手册](OPERATIONS.md)。不要和同一应用的已有长连接实例并行测试，以免事件分发到另一个实例。

备份时分开保存 `config/settings.local.json`、凭据和两个 runtime；备份不进 GitHub。启动会将已 claim 的中断任务标为 interrupted，不自动重跑。核实真实引擎状态后再新建任务。配对、发布权限、首次登录等必须由账号所有者完成；AI 不应伪造完成。

## 9. 知识、计划与后台任务

1. 知识放在 `workspace.local` 下的 `knowledge/`，通过 manifest 指定 Markdown/TXT，不扫描已有磁盘目录。设置 `knowledge.enabled=true`，逐文件填写哈希、模型许可及用户/会话 ACL。见 [知识配置](KNOWLEDGE.md)。
2. 发齐测试附件，`/files` 看编号，`/workflows` 看流程。`/plan <自然语言需求>` 后核对预览，再 `/submit <预览ID>`；缺项先补充。见 [规划](PLANNING.md)。
3. 默认任务只建档，`/run <任务ID>` 后台执行；`/cancel`、`/tasks`、`/status` 控制与查看。`/result` 仍只发 output 文件。见 [队列](TASK_QUEUE.md)。
4. `/health` 看本会话状态，`npm run status` 看本机脱敏快照。最近响应型号未由提供方报告时显示 null，不把配置名当实际推理证据。

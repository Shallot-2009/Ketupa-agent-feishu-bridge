# 长期运维手册

## 1. 首次上线顺序

1. 在新目录解压公开包，`npm ci --ignore-scripts`，`npm run init`。
2. 按 CONFIGURE.md 创建测试应用、事件权限、可用范围和私聊配对；密钥只填本机配置。
3. 配置模型和文字授权；用独立运行账号，不导入私人 MCP 或已有生产配置。
4. `npm test`、`npm run doctor`、`npm run doctor -- --live`。
5. 实际验证普通对话、上下文、附件保存、demo、output 文件交付，再接自己的执行器。
6. 启用知识前逐文件审阅并授权，用“有证据、无证据、撤权”三个场景验收。

自动测试不消耗真实模型调用、不登录账号、不代表平台或真实引擎验收。当前公开包不包含 Aily 适配器和商业求解器；不要沿用其他系统已打通的结论。

## 2. 配置位置与含义

| 位置/字段                                          | 内容                                                    |
| -------------------------------------------------- | ------------------------------------------------------- |
| config/.env                                        | 飞书凭证、兼容 API 地址/密钥、可选独立 CODEX_HOME       |
| config/settings.local.json → feishu                | 区域、用户和会话白名单、群 @ 策略                       |
| model.provider / name                              | codex 或 openai-compatible；所用服务实际支持的型号      |
| model.sendChatToModel                              | 是否允许授权文字历史发送到所配模型，默认 false          |
| model.maxHistoryMessages / maxHistoryChars         | 默认 16 条、16000 字符，控制 API 历史开销               |
| model.maxOutputTokens                              | 兼容 API 默认 500；结构化预览至少 1200，以容纳参数 JSON |
| tasks.concurrency / maxPending                     | 默认 1 / 50；CLI 配置最多并发 4、等待 200               |
| tasks.autoRun                                      | 默认 false；显式提交后是否立即排队                      |
| tasks.workflows                                    | 固定执行器、输入类型、参数 schema、超时                 |
| knowledge.enabled / maxEvidenceChars / maxSnippets | 默认关闭，启用时默认 4000 字符、3 个片段                |
| workspace.local / tasks                            | 分离的飞书与任务 runtime，均禁止提交源码仓库            |

修改配置后重启服务使其生效；知识 manifest 和正文每次查询重新校验，无需重启。共享场景中不要把所有人都配置成 owner。

Codex 后端沿用 thread，服务端仍可能保留完整上下文；本包的历史字符上限不等于限制 Codex 服务端的累计上下文或账单。通过 `/reset` 建立新的模型上下文，按提供方计费规则监控费用。

## 3. 运行与状态

```sh
npm start
npm run status
npm run doctor
npm run doctor -- --live
```

`status` 返回脱敏 JSON：进程是否存活、最近入站时间、配置模型、最近响应中服务报告的模型、空间使用量。`lastReported=null` 表示提供方没有返回型号；Codex JSON 事件未证明实际型号时保持 null，不能拿配置值冒充。

`processAlive=true` 只代表实例锁对应的进程存在。`feishuAuth/feishuBot=true` 只代表诊断时凭证和机器人身份探测成功。不代表 WS 持续在线、事件权限齐全、模型可推理或求解器能运行。长期没收到消息也可能只是没有人发消息。

聊天 `/health` 只显示本发送者会话信息；`/tasks` 查看最近任务，`/status ID` 查看状态，`/files` 查看已接收附件。诊断与聊天均不会输出密钥、完整本机路径或 SDK 原始错误。

## 4. 后台运行和开机启动

本包不修改系统服务或注册表。先用普通启动完成真实验收，再交给系统自带服务管理器：

- Windows 任务计划程序：程序选择本机 `node.exe`，参数为 `--env-file-if-exists=config/.env bridge/cli.mjs start`，起始位置为本项目根目录；触发器设为登录/开机，勾选隐藏，设置失败后间隔 1 分钟重启；已有实例运行时不要启动新实例。使用专用低权限账号，检查“仅在用户登录时运行”等设置是否会显示窗口。
- Linux：使用自己管理的 systemd 服务，WorkingDirectory 为本项目目录，ExecStart 使用同样的 node 参数；设置专用 User、Restart=on-failure、RestartSec=10，限制可读写目录。

任务执行和 Codex 子进程由程序以 `shell:false` 启动，Windows 使用 `windowsHide:true`。不通过 PowerShell 窗口保活。避免使用“每条消息重新启动服务”的方式。

同一应用只运行一套网关。实例锁覆盖两个 runtime，队列另外有 owner 锁；更改目录创建第二套实例仍可能抢同一飞书应用的事件，不能用目录锁替代部署管理。

## 5. 提交、取消与交付

```text
/files
/workflows
/plan 用刚上传的文本建一个 demo，case 叫 example，message 为 hello
/submit <预览ID>
/run <任务ID>
/tasks
/status <任务ID>
/cancel <任务ID>
/result <任务ID>
```

每次提交一个带时间戳的新工程，只允许本任务 output 交付。其他工程、input、cir、include、logs、temp 和 ARCHIVE.md 不发送到聊天。用户执行器需要压缩时，在 output 内生成并检查 ZIP；不要压缩整个工程。聊天命令确认和故障提示是文本，结果交付仅发文件。

重启后正在运行/已 claim 的非完成任务标为 interrupted；保留未启动 queued 任务，但不自动重跑。`/cancel` 终止本进程启动的任务树，不能撤销已经发生的外部写入。求解器支持远端任务时，执行器应实现其自己的撤销逻辑。

## 6. 异常排查

| 现象                       | 排查顺序                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| 没有飞书回复               | 进程状态 → 应用凭证/区域 → 已发布与可用范围 → 接收事件权限 → 双白名单 → @ 的是本机器人     |
| 附件没有落盘               | 是否收到原消息事件 → 原消息资源读取权限 → 文件大小 → 本会话 `/files`；不要求先传云盘       |
| 没有知识证据               | enabled → manifest 结构 → allowModel → 用户/会话同时授权 → 哈希 → 搜索词是否匹配           |
| 专业问答泛泛而谈           | 检查知识授权、命中词和相关资料质量；不会自动把未授权原库全量上传模型                       |
| 计划缺参数或附件           | 按预览缺项补充；同类型多文件明确编号，再次 `/plan`，不要猜测默认值                         |
| 任务持续 queued            | 默认不自动运行，执行 `/run`；或队列满、已有 claim、执行器未配置；查看 `/status`            |
| 任务 failed/interrupted    | 本机检查 state、logs 与执行器；核实外部进程/远端作业，另建任务重试，不删除 claim 重跑      |
| 提交中断/claim 存在        | 从 `/tasks` 与工程 state 查是否已有任务；不能确定时停止自动重提，先由管理员核对            |
| 回包失败后重复消息无反应   | 收据阻止重复副作用；用新消息 `/tasks`、`/files` 核实，不重复触发原任务                     |
| 实例锁阻止启动             | 检查已有服务与 PID；已死 PID 可恢复，PID 被复用/权限不明时人工核对；不要按目录名批量杀进程 |
| service-recovery.lock 残留 | 先停掉所有共享这两个 runtime 的实例，备份后确认无启动进程，再移除这个空恢复锁目录          |

不要在 issue 中上传原始日志或配置。错误里可能包含业务执行器自己写出的路径或内容，公开前由本人脱敏。

## 7. 备份、保留和升级

停止服务并确认子进程退出后，分别备份本机配置/凭据、飞书 runtime、任务 runtime。备份必须保留会话审计、receipts、plans、附件、任务状态、run.claim 和 cancel.request；只恢复 job.json 而漏掉 claim 可能引入不一致。凭据单独加密保存，不进 Git。

保留期限由管理员按需求制定。程序不默认删除任何记录；附件索引保留最近 100 条，但历史附件文件和原始审计仍可能占空间。定期查看 status 的 bytes/files，设置磁盘告警。扫描超出 10000 文件或 8 层时返回 truncated，不能当成全盘统计。已归档工程整体转冷存储；不要单独清理仍在用的收据或 claim。

升级时先备份，将新源码放入干净目录，安装锁定依赖，迁移本机配置字段并继续使用相同的两个私有 runtime。停止旧服务后再启动新服务。回退同样只替换源码；先检查状态格式与正在执行的外部作业，禁止双实例并行。

## 8. 发布体检

```sh
npm ci --ignore-scripts
npm test
npm audit --omit=dev --audit-level=high
npm run release:check
node scripts/release-check.mjs --tracked
npm run release:pack
```

`--tracked` 仅在本公开项目的 Git 仓库根执行。打包重置 VALIDATION.json，不能把旧测试结果沿用到新 ZIP。发布前按 PUBLIC_MANIFEST.json 逐项核验解压文件；只上传白名单源码，不上传任何 runtime、凭据、工程、外部执行器或参考包。

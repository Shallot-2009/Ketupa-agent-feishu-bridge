# 配置目录

| 文件                    | 用途                                          | 可提交 |
| ----------------------- | --------------------------------------------- | ------ |
| `settings.example.json` | 不含账号的默认配置                            | 是     |
| `.env.example`          | 空凭据模板                                    | 是     |
| `settings.local.json`   | init 后生成，保存个人模型、白名单和工作区位置 | 否     |
| `.env`                  | init 后生成，保存真实密钥                     | 否     |

从项目根运行 `npm run init`；不会覆盖已有配置。随后在本机填写 `.env` 和 `settings.local.json`。

`workspace.local` 指向 **feishu-workspace/runtime**：飞书对话、附件和模型上下文。

`workspace.tasks` 指向 **ketupa-workspace/runtime**：每次提交独立的 Ketupa / 外部任务工程。

路径相对于项目根解析，不相对于本配置目录。两个工作区不能重叠。真实位置仅写在忽略上传的本地配置中。

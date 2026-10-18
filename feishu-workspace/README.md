# 飞书本地工作区接口

**这是飞书路径**：配置字段 `workspace.local`，默认 `./feishu-workspace/runtime`，相对于项目根目录。与仿真工程目录分开管理。配置位置见 [config](../config/README.md)。

本模块保存**服务运行后实际收到的、白名单用户在白名单会话中发送的消息和附件**。它不接管飞书，也不抓取整个组织、其他账号或任意历史。

```text
runtime/                       私人目录，禁止提交
  conversations/<hash>/        按 chat + sender 隔离
    messages.jsonl             对话与事件归档
    state.json                 Codex thread、去重状态
    attachments.json           当前会话的本地附件索引
    files/                     收到并验证落盘的原文件
    model/                     本会话 Codex 调用 cwd
    receipts/                  处理前持久收据，阻止消息重投重复执行
    plans/                     一小时有效的参数预览与提交 claim
  knowledge/                   显式授权的纯文本知识与 manifest.json
  runtime.json                 脱敏的最近活动观测
  service.lock.json            实例互斥；不证明平台连通
```

`store.mjs` 提供 `Workspace` 接口；`files.mjs` 统一检查相对路径和符号链接。会话哈希是文件名隔离，不是匿名化；记录正文与文件仍然是私人数据。文件名被清理，附件上限默认 32 MiB，失败就不宣称下载成功。

群内消息也按发送者分开，不能由群里的另一个人读取你的附件或任务；群附件必须由同一提交人在同一会话中发送。模型每次最多取配置数量的文本消息，归档保留在本机。API 历史只发送有上限的文字；Codex 通过原 thread 续聊。

`knowledge.mjs` 提供授权 Markdown/TXT 片段检索；按照 [知识配置](../docs/KNOWLEDGE.md) 填写显式清单，默认关闭。不实现自动学习人格、模型训练或全量历史同步；保存记录不会自动让模型变聪明。

知识策略或模型配置变化会重置模型 thread 与可发送历史代次；`/reset` 也可主动重置。原始审计保留；删除个人数据需停服务后按保留策略处理，不能把重置误认为删除。

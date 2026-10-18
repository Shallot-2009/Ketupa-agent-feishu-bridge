# Ketupa / 外部任务工作区接口

**这是 Ketupa 任务工程路径**：配置字段 `workspace.tasks`，默认 `./ketupa-workspace/runtime`，相对于项目根目录。每次提交新建一个带时间戳和 case 名的工程。飞书原始聊天和附件由独立的 feishu-workspace 保存，只把当前任务选定的输入复制到本工程。

只负责**输入清单、参数校验、工程目录、固定执行器调用和输出交付**。求解器、网表生成、模型算法和业务校验由用户自己的外部程序提供，不在这个源码包中。

## 每次提交一个工程

```text
runtime/YYYYMMDD-HHmmss_case_random/
  ARCHIVE.md          本任务输入、参数、时间、状态
  state/job.json      执行器读取的规范请求
  state/run.claim     防止重复执行的持久标志
  input/              仅从本会话已落盘的附件复制
  cir/                留给用户自己的网表生成器
  include/            留给外部执行器的依赖
  output/             唯一允许交付的目录
  logs/               执行日志，仅留本机
  temp/               临时文件，仅留本机
```

目录用配置时区，追加随机后缀避免同秒冲突。相同任务 ID 不能重复执行。中断任务不会自动重新求解；管理员应先核实真实引擎状态。

## 注册自己的 workflow

在 `config/settings.local.json` 的 `tasks.workflows` 中添加，以下只是接口配置形状，不代表任何真实引擎语法：

```json
{
  "extract": {
    "description": "My external extraction adapter",
    "inputs": { "layout": [".brd"], "stackup": [".xml"] },
    "parameters": {
      "startGHz": { "type": "number", "min": 0, "required": true },
      "stopGHz": { "type": "number", "min": 0, "required": true },
      "mode": { "type": "string", "enum": ["extract"], "required": true }
    },
    "command": {
      "file": "<本机执行器的原生可执行文件>",
      "args": ["--request", "{request}", "--output", "{output}"]
    },
    "timeoutMs": 300000
  }
}
```

仅替换本机配置内的占位符；如果使用 Node/Python，file 为该解释器，args 第一项为自己脚本的绝对路径。只允许明确指定的程序和固定 args，不运行 shell 包装器。用户参数从 request JSON 读取，不替换进命令行。子进程 cwd 为当前任务；环境不透传飞书或模型密钥。

在飞书提交：

```text
/task extract example {"params":{"startGHz":0.1,"stopGHz":20,"mode":"extract"}}
```

先发齐输入文件；缺文件时返回输入名称，多个同类文件必须通过 files 字段明确编号。不能让模型猜层叠、网络或数值。本层仅做声明的类型/范围校验；跨字段物理约束、网表正确性和输出有效性必须由自己的执行器校验，失败时用非零退出码。

执行器从 `TASK_REQUEST_FILE` 或 `{request}` 读取 job JSON，把可交付结果写到 `TASK_OUTPUT_DIR` 或 `{output}`。成功返回 0，失败返回非零。本层的 succeeded 表示执行器成功退出，**不证明工程物理正确或 signoff 完成**。目录内数据与配置均为私人资料。

默认 `autoRun=false`。发送 `/run 任务ID` 或本机运行 `npm run worker -- 任务ID` 才执行；明确完成执行器验证后可改为 true。`/result` 只发送 output 下的文件，拒绝符号链接、超过 20 个文件、超过 32 MiB 的单文件。需要压缩包时由执行器自己生成并验证，不能打包 input、logs 或整个工作盘。

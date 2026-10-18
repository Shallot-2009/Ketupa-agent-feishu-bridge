import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Gateway } from "../bridge/service.mjs";
import { Workspace } from "../feishu-workspace/store.mjs";
import { TaskWorkspace } from "../ketupa-workspace/tasks.mjs";
test("authorized attachment-to-task-to-output delivery and dedup; unknown users are ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-integration-"));
  try {
    const local = new Workspace(join(root, "local"));
    await local.init();
    const tasks = new TaskWorkspace(join(root, "tasks"), local, {
      demo: { inputs: { source: [".txt"] }, parameters: {}, builtin: "demo" },
    });
    const replies = [],
      uploads = [];
    const client = {
      im: {
        message: {
          reply: async (req) => {
            replies.push(req.data);
            return { code: 0 };
          },
        },
        messageResource: {
          get: async () => ({
            getReadableStream: () =>
              Readable.from([Buffer.from("sample input")]),
          }),
        },
        file: {
          create: async (req) => {
            let bytes = 0;
            for await (const b of req.data.file) bytes += b.length;
            uploads.push({ name: req.data.file_name, bytes });
            return { code: 0, data: { file_key: "test-file" } };
          },
        },
      },
    };
    const config = {
      feishu: {
        allowedUsers: ["owner"],
        allowedChats: ["chat"],
        requireMentionInGroups: true,
      },
      tasks: { autoRun: false },
      model: { sendChatToModel: false },
    };
    const gateway = new Gateway(config, client, local, tasks);
    const event = (id, type, content, user = "owner") => ({
      sender: { sender_type: "user", sender_id: { open_id: user } },
      message: {
        message_id: id,
        chat_id: "chat",
        chat_type: "p2p",
        message_type: type,
        content: JSON.stringify(content),
      },
    });
    await gateway.receive(event("x", "text", { text: "secret" }, "stranger"));
    assert.equal((await readdir(local.root)).length, 0);
    const file = event("a", "file", {
      file_key: "test-key",
      file_name: "sample.txt",
    });
    await gateway.receive(file);
    await gateway.receive(file);
    assert.equal(replies.length, 1);
    await gateway.receive(
      event("b", "text", { text: "/task demo example {}" }),
    );
    const dirs = await readdir(tasks.root);
    assert.equal(dirs.length, 1);
    const id = dirs[0];
    await gateway.receive(event("c", "text", { text: "/run " + id }));
    await gateway.queue.idle();
    await gateway.receive(event("d", "text", { text: "/result " + id }));
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].name, "result.json");
    assert.ok(uploads[0].bytes > 0);
    assert.equal(replies.at(-1).msg_type, "file");
    await gateway.queue.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("group trigger must mention this bot, not another person", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-mention-"));
  try {
    const local = new Workspace(join(root, "local"));
    await local.init();
    let replies = 0;
    const client = {
      im: {
        message: {
          reply: async () => {
            replies++;
            return { code: 0 };
          },
        },
      },
    };
    const g = new Gateway(
      {
        feishu: {
          allowedUsers: ["owner"],
          allowedChats: ["group"],
          requireMentionInGroups: true,
          botOpenId: "this-bot",
        },
        tasks: {},
        model: {},
      },
      client,
      local,
      {},
    );
    const event = (id) => ({
      sender: { sender_type: "user", sender_id: { open_id: "owner" } },
      message: {
        message_id: id,
        chat_id: "group",
        chat_type: "group",
        message_type: "text",
        mentions: [{ id: { open_id: id } }],
        content: JSON.stringify({ text: "/help" }),
      },
    });
    await g.receive(event("other-person"));
    assert.equal(replies, 0);
    await g.receive(event("this-bot"));
    assert.equal(replies, 1);
    delete g.config.feishu.botOpenId;
    const unresolved = event("missing-bot-identity");
    unresolved.message.mentions = [{ id: { user_id: "another-person" } }];
    await g.receive(unresolved);
    assert.equal(
      replies,
      1,
      "missing bot identity must not match missing mention open_id",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

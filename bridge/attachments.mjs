import { createReadStream } from "node:fs";

export async function saveIncomingFile(client, local, key, message, content) {
  const fileKey = content.file_key || content.image_key;
  if (!fileKey) throw new Error("attachment resource missing");
  const type = message.message_type === "image" ? "image" : "file";
  const resource = await client.im.messageResource.get({
    path: { message_id: message.message_id, file_key: fileKey },
    params: { type },
  });
  const stream = resource.getReadableStream();
  const timeout = setTimeout(
    () => stream.destroy(new Error("attachment timeout")),
    30000,
  );
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > local.maxBytes) {
        stream.destroy();
        throw new Error("attachment too large");
      }
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timeout);
  }
  const file = await local.saveAttachment(
    key,
    message.message_id,
    content.file_name || (type === "image" ? "image.png" : "attachment.bin"),
    Buffer.concat(chunks),
  );
  await local.append(key, {
    type: "attachment",
    id: file.id,
    name: file.name,
    bytes: file.bytes,
  });
  return file;
}

export async function deliverOutputs(client, tasks, key, id, messageId) {
  const files = await tasks.outputs(key, id);
  if (!files.length) throw new Error("output is empty");
  for (const file of files) {
    const uploaded = await client.im.file.create({
      data: {
        file_type: "stream",
        file_name: file.name.replaceAll("/", "_"),
        file: createReadStream(file.path),
      },
    });
    if (uploaded.code !== 0 || !uploaded.data?.file_key)
      throw new Error("upload failed");
    const sent = await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "file",
        content: JSON.stringify({ file_key: uploaded.data.file_key }),
      },
    });
    if (sent.code !== 0) throw new Error("file delivery failed");
  }
}

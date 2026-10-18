import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const principal = { user: "reader-a", chat: "room-a", text: "orbital" };

async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), "knowledge-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "knowledge");
  await mkdir(root);
  let module;
  try {
    module = await import("../feishu-workspace/knowledge.mjs");
  } catch (error) {
    assert.fail(`Knowledge implementation must be importable: ${error.code}`);
  }
  const knowledge = new module.Knowledge(root, { enabled: true, ...options });
  const manifest = (documents) =>
    writeFile(join(root, "manifest.json"), JSON.stringify({ documents }));
  const document = async (id, text, overrides = {}) => {
    const path = `${id}.md`;
    await writeFile(join(root, path), text);
    return {
      id,
      path,
      sha256: digest(text),
      allowModel: true,
      allowedUsers: ["reader-a"],
      allowedChats: ["room-a"],
      ...overrides,
    };
  };
  return { base, root, knowledge, manifest, document };
}

test("returns only documents granted to both the user and chat", async (t) => {
  const f = await fixture(t);
  await f.manifest([
    await f.document("approved", "Orbital scheduling reference."),
    await f.document("other-user", "Orbital user secret.", {
      allowedUsers: ["reader-b"],
    }),
    await f.document("other-chat", "Orbital chat secret.", {
      allowedChats: ["room-b"],
    }),
  ]);
  const result = await f.knowledge.query(principal);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.evidence, [
    {
      id: "approved",
      text: "Orbital scheduling reference.",
      sha256: digest("Orbital scheduling reference."),
    },
  ]);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /other-user|other-chat|secret/);
});

test("denies grants with an empty user or chat allowlist", async (t) => {
  const f = await fixture(t);
  await f.manifest([
    await f.document("no-users", "Orbital secret.", { allowedUsers: [] }),
    await f.document("no-chats", "Orbital secret.", { allowedChats: [] }),
  ]);
  assert.deepEqual((await f.knowledge.query(principal)).evidence, []);
});

test("requires the explicit boolean model grant", async (t) => {
  const f = await fixture(t);
  const denied = await f.document("no-model", "Orbital secret.", {
    allowModel: false,
  });
  await f.manifest([denied]);
  assert.deepEqual((await f.knowledge.query(principal)).evidence, []);
  delete denied.allowModel;
  await f.manifest([denied]);
  assert.deepEqual((await f.knowledge.query(principal)).evidence, []);
});

test("is disabled unless explicitly enabled", async (t) => {
  const f = await fixture(t, { enabled: false });
  await f.manifest([await f.document("approved", "Orbital notes.")]);
  const result = await f.knowledge.query(principal);
  assert.equal(result.status, "disabled");
  assert.deepEqual(result.evidence, []);
  const { Knowledge } = await import("../feishu-workspace/knowledge.mjs");
  assert.equal(
    (await new Knowledge(f.root).query(principal)).status,
    "disabled",
  );
});

test("withholds changed bytes and changes the context fingerprint", async (t) => {
  const f = await fixture(t);
  await f.manifest([await f.document("approved", "Orbital original.")]);
  const before = await f.knowledge.query(principal);
  await writeFile(join(f.root, "approved.md"), "Orbital modified.");
  const after = await f.knowledge.query(principal);
  assert.deepEqual(after.evidence, []);
  assert.notEqual(after.fingerprint, before.fingerprint);
  await writeFile(join(f.root, "approved.md"), "Orbital modified again.");
  assert.notEqual(
    (await f.knowledge.query(principal)).fingerprint,
    after.fingerprint,
  );
});

test("revocation changes the fingerprint and removes evidence", async (t) => {
  const f = await fixture(t);
  const doc = await f.document("approved", "Orbital reference.");
  await f.manifest([doc]);
  const before = await f.knowledge.query(principal);
  await f.manifest([{ ...doc, allowedUsers: [] }]);
  const after = await f.knowledge.query(principal);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.deepEqual(after.evidence, []);
});

test("greetings skip evidence while tracking policy and byte changes", async (t) => {
  const f = await fixture(t);
  const doc = await f.document("approved", "Orbital reference.");
  await f.manifest([doc]);
  const first = await f.knowledge.query({ ...principal, text: "你好" });
  assert.equal(first.status, "skipped");
  assert.deepEqual(first.evidence, []);
  await writeFile(join(f.root, "approved.md"), "Changed during greeting.");
  const second = await f.knowledge.query({ ...principal, text: "hello" });
  assert.notEqual(second.fingerprint, first.fingerprint);
  await f.manifest([{ ...doc, allowModel: false }]);
  assert.notEqual(
    (await f.knowledge.query({ ...principal, text: "hi" })).fingerprint,
    second.fingerprint,
  );
});

test("fingerprints do not depend on search text but are scoped to the principal", async (t) => {
  const f = await fixture(t);
  await f.manifest([await f.document("approved", "Orbital reference.")]);
  const first = await f.knowledge.query(principal);
  assert.equal(
    (await f.knowledge.query({ ...principal, text: "different" })).fingerprint,
    first.fingerprint,
  );
  assert.notEqual(
    (await f.knowledge.query({ ...principal, user: "reader-b" })).fingerprint,
    first.fingerprint,
  );
});

test("missing and malformed manifests fail closed and reset a previous context", async (t) => {
  const f = await fixture(t);
  const missing = await f.knowledge.query(principal);
  assert.equal(missing.status, "unavailable");
  assert.deepEqual(missing.evidence, []);
  await f.manifest([await f.document("approved", "Orbital reference.")]);
  const valid = await f.knowledge.query(principal);
  await writeFile(join(f.root, "manifest.json"), "{malformed");
  const invalid = await f.knowledge.query(principal);
  assert.equal(invalid.status, "policy-error");
  assert.deepEqual(invalid.evidence, []);
  assert.notEqual(invalid.fingerprint, valid.fingerprint);
  await rm(join(f.root, "manifest.json"));
  assert.notEqual(
    (await f.knowledge.query(principal)).fingerprint,
    valid.fingerprint,
  );
});

test("rejects traversal and absolute document paths without leaking metadata", async (t) => {
  const f = await fixture(t);
  const secret = "Orbital outside secret.";
  await writeFile(join(f.base, "outside.txt"), secret);
  const doc = await f.document("approved", "Orbital reference.");
  const foreignAbsolute = ["C:", "outside.txt"].join(String.fromCharCode(92));
  for (const path of [
    "../outside.txt",
    "..\\outside.txt",
    join(f.base, "outside.txt"),
    foreignAbsolute,
  ]) {
    await f.manifest([
      { ...doc, id: "sensitive-name", path, sha256: digest(secret) },
    ]);
    const result = await f.knowledge.query(principal);
    assert.equal(result.status, "policy-error");
    assert.deepEqual(result.evidence, []);
    assert.doesNotMatch(
      JSON.stringify(result),
      /outside|sensitive-name|secret/,
    );
  }
});

test("does not discover unlisted files or match unrelated documents", async (t) => {
  const f = await fixture(t);
  await f.document("unlisted", "Orbital unlisted secret.");
  await f.manifest([await f.document("approved", "Marine navigation only.")]);
  const result = await f.knowledge.query(principal);
  assert.equal(result.status, "empty");
  assert.deepEqual(result.evidence, []);
});

test("rejects PDF and Word entries instead of treating them as text", async (t) => {
  const f = await fixture(t);
  const doc = await f.document("approved", "Orbital reference.");
  for (const path of ["reference.pdf", "reference.docx"]) {
    await f.manifest([{ ...doc, path }]);
    const result = await f.knowledge.query(principal);
    assert.equal(result.status, "policy-error");
    assert.deepEqual(result.evidence, []);
  }
});

test("caps the total evidence size and the number of snippets", async (t) => {
  const f = await fixture(t, { maxEvidenceChars: 73, maxSnippets: 2 });
  await f.manifest(
    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        f.document(`doc-${i}`, `Orbital ${i} ${"bounded content ".repeat(30)}`),
      ),
    ),
  );
  const result = await f.knowledge.query(principal);
  assert.ok(result.evidence.length > 0);
  assert.ok(result.evidence.length <= 2);
  assert.ok(
    result.evidence.reduce((sum, item) => sum + item.text.length, 0) <= 73,
  );
});

test("retrieves a matching passage beyond the start of a document", async (t) => {
  const f = await fixture(t, { maxEvidenceChars: 100 });
  await f.manifest([
    await f.document(
      "approved",
      `${"unrelated ".repeat(100)}\nOrbital launch window is Tuesday.`,
    ),
  ]);
  const result = await f.knowledge.query(principal);
  assert.match(result.evidence[0].text, /Orbital launch window/);
});

test("rejects oversized documents and manifests", async (t) => {
  const f = await fixture(t);
  await f.manifest([
    await f.document("huge", `Orbital ${"x".repeat(300 * 1024)}`),
  ]);
  assert.deepEqual((await f.knowledge.query(principal)).evidence, []);
  await writeFile(join(f.root, "manifest.json"), " ".repeat(129 * 1024));
  const result = await f.knowledge.query(principal);
  assert.equal(result.status, "policy-error");
  assert.deepEqual(result.evidence, []);
});

test("invalid policy shape and duplicate ids fail closed", async (t) => {
  const f = await fixture(t);
  const doc = await f.document("approved", "Orbital reference.");
  for (const documents of [
    [doc, doc],
    [{ ...doc, allowedUsers: "*" }],
    [{ ...doc, sha256: "wrong" }],
    Array(65).fill(doc),
  ]) {
    await f.manifest(documents);
    const result = await f.knowledge.query(principal);
    assert.equal(result.status, "policy-error");
    assert.deepEqual(result.evidence, []);
  }
});

test("missing authorized documents change the fingerprint without returning their identity", async (t) => {
  const f = await fixture(t);
  await f.manifest([await f.document("approved", "Orbital reference.")]);
  const before = await f.knowledge.query(principal);
  await rm(join(f.root, "approved.md"));
  const after = await f.knowledge.query(principal);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.deepEqual(after.evidence, []);
});

test("rejects symbolic links for documents and the manifest", async (t) => {
  const f = await fixture(t);
  const doc = await f.document("approved", "Orbital reference.");
  await f.manifest([doc]);
  const before = await f.knowledge.query(principal);
  await rm(join(f.root, "approved.md"));
  const outside = join(f.base, "outside.txt");
  await writeFile(outside, "Orbital reference.");
  try {
    await symlink(outside, join(f.root, "approved.md"), "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code))
      return t.skip("File symlinks unavailable on this host");
    throw error;
  }
  const linked = await f.knowledge.query(principal);
  assert.deepEqual(linked.evidence, []);
  assert.notEqual(linked.fingerprint, before.fingerprint);
  await rm(join(f.root, "manifest.json"));
  const outsideManifest = join(f.base, "outside-manifest.json");
  await writeFile(outsideManifest, JSON.stringify({ documents: [doc] }));
  await symlink(outsideManifest, join(f.root, "manifest.json"), "file");
  assert.deepEqual((await f.knowledge.query(principal)).evidence, []);
});

test("rejects a junction inside the knowledge root", async (t) => {
  const f = await fixture(t);
  const external = join(f.base, "external");
  await mkdir(external);
  await writeFile(join(external, "linked.txt"), "Orbital junction secret.");
  try {
    await symlink(
      external,
      join(f.root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code))
      return t.skip("Directory links unavailable on this host");
    throw error;
  }
  const doc = await f.document("approved", "Unused source.");
  await f.manifest([
    {
      ...doc,
      path: "linked/linked.txt",
      sha256: digest("Orbital junction secret."),
    },
  ]);
  assert.deepEqual((await f.knowledge.query(principal)).evidence, []);
});

test("segments Chinese queries to find relevant authorized passages", async (t) => {
  const f = await fixture(t);
  await f.manifest([
    await f.document("approved", "轨道发射的窗口在周二开放。"),
  ]);
  const result = await f.knowledge.query({
    ...principal,
    text: "请查询轨道发射时间",
  });
  assert.equal(result.status, "ok");
  assert.match(result.evidence[0].text, /轨道发射/);
});

test("rejects more than 64 distinct manifest entries", async (t) => {
  const f = await fixture(t);
  const doc = await f.document("approved", "Orbital reference.");
  await f.manifest(
    Array.from({ length: 65 }, (_, i) => ({ ...doc, id: `entry-${i}` })),
  );
  const result = await f.knowledge.query(principal);
  assert.equal(result.status, "policy-error");
  assert.deepEqual(result.evidence, []);
});

test("caps total document bytes before a later document can supply evidence", async (t) => {
  const f = await fixture(t);
  const documents = [];
  for (let index = 0; index < 17; index += 1) {
    const prefix = index === 16 ? "Orbital target." : "Marine background.";
    documents.push(
      await f.document(`entry-${index}`, prefix.padEnd(256 * 1024, " ")),
    );
  }
  await f.manifest(documents);
  const result = await f.knowledge.query(principal);
  assert.deepEqual(result.evidence, []);
});

test("bounds UTF-8 evidence bytes without splitting Unicode characters", async (t) => {
  const f = await fixture(t, { maxEvidenceChars: 16000, maxSnippets: 16 });
  await f.manifest(
    await Promise.all(
      [0, 1, 2, 3, 4, 5].map((index) =>
        f.document(`entry-${index}`, `轨道发射 ${"中文😀".repeat(1000)}`),
      ),
    ),
  );
  const result = await f.knowledge.query({ ...principal, text: "轨道发射" });
  const combined = result.evidence.map((item) => item.text).join("");
  assert.ok(result.evidence.length > 1);
  assert.ok(Buffer.byteLength(combined, "utf8") <= 8000);
  assert.equal(combined.isWellFormed(), true);
});

test("a linked knowledge root is rejected even if all contents are otherwise authorized", async (t) => {
  const f = await fixture(t);
  await f.manifest([await f.document("approved", "Orbital reference.")]);
  const linkedRoot = join(f.base, "linked-root");
  try {
    await symlink(
      f.root,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code))
      return t.skip("Directory links unavailable on this host");
    throw error;
  }
  const { Knowledge } = await import("../feishu-workspace/knowledge.mjs");
  const result = await new Knowledge(linkedRoot, { enabled: true }).query(
    principal,
  );
  assert.equal(result.status, "policy-error");
  assert.deepEqual(result.evidence, []);
});

test("missing ACL fields never imply an authorization grant", async (t) => {
  const f = await fixture(t);
  const doc = await f.document("approved", "Orbital reference.");
  delete doc.allowedUsers;
  delete doc.allowedChats;
  await f.manifest([doc]);
  assert.deepEqual((await f.knowledge.query(principal)).evidence, []);
});

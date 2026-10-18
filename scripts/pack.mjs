import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { auditSources, privateTerms } from "./release-policy.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  out = resolve(root, process.argv[2] || "release");
const result = await auditSources(root, await privateTerms());
if (result.findings.length) {
  console.error(JSON.stringify({ findings: result.findings }));
  process.exit(1);
}
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = {
  schemaVersion: 1,
  name: pkg.name,
  version: pkg.version,
  files: result.files.map(({ path, bytes, sha256 }) => ({
    path,
    bytes,
    sha256,
  })),
};
const files = [
  ...result.files,
  {
    path: "docs/PUBLIC_MANIFEST.json",
    buffer: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
  },
];
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
const chunks = [],
  central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(pkg.name + "/" + file.path),
    data = deflateRawSync(file.buffer),
    crc = crc32(file.buffer);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0x5c21, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(file.buffer.length, 22);
  header.writeUInt16LE(name.length, 26);
  chunks.push(header, name, data);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50);
  dir.writeUInt16LE(0x0314, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(0x800, 8);
  dir.writeUInt16LE(8, 10);
  dir.writeUInt16LE(0x5c21, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(data.length, 20);
  dir.writeUInt32LE(file.buffer.length, 24);
  dir.writeUInt16LE(name.length, 28);
  dir.writeUInt32LE(
    ((file.path === ".githooks/pre-commit" ? 0o100755 : 0o100644) << 16) >>> 0,
    38,
  );
  dir.writeUInt32LE(offset, 42);
  central.push(dir, name);
  offset += header.length + name.length + data.length;
}
const centralBuffer = Buffer.concat(central),
  end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...chunks, centralBuffer, end]),
  name = pkg.name + ".zip";
await mkdir(out, { recursive: true });
await writeFile(join(out, name), zip);
const hash = createHash("sha256").update(zip).digest("hex");
await writeFile(join(out, name + ".sha256"), hash + "  " + name + "\n");
await writeFile(
  join(out, "PUBLIC_MANIFEST.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      archive: name,
      files: files.length,
      sourceBytes: result.files.reduce((s, f) => s + f.bytes, 0),
      zipBytes: zip.length,
      sha256: hash,
    },
    null,
    2,
  ),
);
// A new archive must not inherit a previous archive's successful validation.
await writeFile(
  join(out, "VALIDATION.json"),
  JSON.stringify(
    {
      sha256: hash,
      sourceScanFindings: 0,
      testsPassed: null,
      testsFailed: null,
      note: "Pack only scans source. Run tests, dependency audit and archive verification for this hash.",
    },
    null,
    2,
  ) + "\n",
);

import { lstat, mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
export async function guard(root, path) {
  const rel = relative(resolve(root), resolve(path));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep))
    throw new Error("path outside workspace");
  let current = resolve(root);
  for (const part of ["", ...rel.split(sep).filter(Boolean)]) {
    current = join(current, part);
    const s = await lstat(current).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (s?.isSymbolicLink()) throw new Error("symbolic link prohibited");
  }
  return path;
}
export async function directory(root, path = root) {
  await guard(root, path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await guard(root, path);
  return path;
}
export async function atomic(root, path, value) {
  await guard(root, path);
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temp, path);
}
export async function readJson(root, path, fallback) {
  await guard(root, path);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

import { spawn, execFile } from "node:child_process";
import { join } from "node:path";
export function run(
  file,
  args,
  {
    cwd,
    env = {},
    input = "",
    timeout = 90000,
    limit = 2 * 1024 * 1024,
    signal,
  } = {},
) {
  if (signal?.aborted)
    return Promise.resolve({ code: "CANCELLED", stdout: "", stderr: "" });
  return new Promise((resolve) => {
    let stdout = "",
      stderr = "",
      done = false,
      timer,
      cleanup,
      child,
      stopped;
    let closed = false,
      treeStopped = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(cleanup);
      signal?.removeEventListener("abort", abort);
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({ code, stdout, stderr });
    };
    const stop = (code) => {
      if (stopped || done) return;
      stopped = code;
      if (!child.pid) {
        finish(code);
        return;
      }
      if (process.platform === "win32") {
        const taskkill = process.env.SystemRoot
          ? join(process.env.SystemRoot, "System32/taskkill.exe")
          : "taskkill.exe";
        execFile(
          taskkill,
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 2000 },
          () => {
            treeStopped = true;
            if (closed) finish(code);
          },
        );
      } else {
        // Only children spawned below have their own process group.
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") child.kill("SIGKILL");
        }
        treeStopped = true;
      }
      cleanup = setTimeout(() => {
        child.kill("SIGKILL");
        finish(code);
      }, 2500);
    };
    const abort = () => stop("CANCELLED");
    try {
      child = spawn(file, args, {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish("SPAWN_FAILED");
      return;
    }
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > limit) {
        stdout = stdout.slice(0, limit);
        stop("OUTPUT_LIMIT");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-limit);
    });
    child.on("error", () => finish(stopped || "SPAWN_FAILED"));
    child.on("close", (code) => {
      closed = true;
      if (!stopped || treeStopped) finish(stopped || String(code ?? "FAILED"));
    });
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => stop("TIMEOUT"), timeout);
    if (signal?.aborted) abort();
    else child.stdin.end(input);
  });
}

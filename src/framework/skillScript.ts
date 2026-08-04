import { spawn } from "node:child_process";

export const SCRIPT_TIMEOUT_MS = 10_000;

export type ScriptOutcome =
  | { ok: true; value: unknown }
  | { ok: false; code: "script_timeout" | "script_failed"; message: string };

/**
 * 在子进程里跑一个 skill 脚本。入参走 stdin JSON，出参从 stdout 解析。
 *
 * 选子进程而不是同进程 import，换来的是「可超时、崩溃不带走服务器」。它不是
 * 权限隔离——本项目没有沙箱，脚本仍以服务器同等权限运行。脚本本身是仓库里的
 * 可信代码，模型只能选择调不调，不能构造被执行的内容。
 */
export function runSkillScript(
  scriptPath: string,
  args: unknown,
  timeoutMs: number = SCRIPT_TIMEOUT_MS,
): Promise<ScriptOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", scriptPath], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (outcome: ScriptOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, code: "script_timeout", message: `Script timed out after ${timeoutMs}ms.` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      finish({ ok: false, code: "script_failed", message: error.message });
    });
    // A child that exits (or never opens stdin) before we finish writing turns
    // the write into EPIPE. Without this listener Node treats it as an uncaught
    // exception on the stream and takes the parent process down with it — which
    // is exactly the crash this module exists to prevent.
    child.stdin.on("error", (error) => {
      finish({ ok: false, code: "script_failed", message: `Failed to write to script stdin: ${error.message}` });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish({
          ok: false,
          code: "script_failed",
          message: `Script exited with ${code}: ${stderr.trim() || "(no stderr)"}`,
        });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(stdout) });
      } catch {
        finish({
          ok: false,
          code: "script_failed",
          message: `Script stdout was not JSON: ${stdout.slice(0, 200)}`,
        });
      }
    });

    child.stdin.end(JSON.stringify(args ?? {}));
  });
}

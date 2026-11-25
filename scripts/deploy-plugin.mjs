import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const MCP_SERVER_NAME = "context-monitor_monitor";
const REFRESH_TIMEOUT_MS = 4_000;

/** 默认线上部署目录，可通过环境变量 CONTEXT_MONITOR_DEPLOY_DIR 或 --target 覆盖 */
export const PLUGIN_DEPLOY_DIR =
  process.env.CONTEXT_MONITOR_DEPLOY_DIR?.trim() ||
  path.join(os.homedir(), ".gemini", "config", "plugins", "context-monitor");

/** 仅同步插件运行时必需的精简文件清单，不拷贝源码、测试或 node_modules */
export const DEPLOY_ENTRIES = Object.freeze([
  "plugin.json",
  "mcp_config.json",
  "assets/logo.svg",
  "dist/server.mjs",
  "dist/app.html",
]);

/** 必须存在且非空的构建产物列表 */
const REQUIRED_BUILD_ARTIFACTS = Object.freeze(["dist/server.mjs", "dist/app.html"]);

/**
 * 规范化 Language Server 地址，剥离可能存在的协议头与尾部斜杠，防止拼接 URL 失败。
 * @param {string} rawAddr
 * @returns {string}
 */
function normalizeLsAddr(rawAddr) {
  return String(rawAddr || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

/**
 * 通过发送 0 信号判断指定 PID 进程是否存活，过滤掉已退出的残留 hub 文件。
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * 发现本地存活的 Antigravity Language Server HTTP 端点（环境变量优先，其次扫描 daemon/hub_*.json）。
 * @returns {Promise<Array<{ addr: string; csrfToken: string }>>}
 */
async function discoverLiveLsEndpoints() {
  /** @type {Array<{ addr: string; csrfToken: string }>} */
  const endpoints = [];
  const pushUnique = (addr, csrfToken) => {
    const cleanAddr = normalizeLsAddr(addr);
    const cleanToken = String(csrfToken || "").trim();
    if (!cleanAddr || !cleanToken) return;
    if (!endpoints.some((e) => e.addr === cleanAddr && e.csrfToken === cleanToken)) {
      endpoints.push({ addr: cleanAddr, csrfToken: cleanToken });
    }
  };

  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    pushUnique(process.env.ANTIGRAVITY_LS_ADDRESS, process.env.ANTIGRAVITY_CSRF_TOKEN);
  }

  const daemonDir = path.join(os.homedir(), ".gemini", "antigravity", "daemon");
  try {
    const files = (await fs.promises.readdir(daemonDir)).filter(
      (f) => f.startsWith("hub_") && f.endsWith(".json"),
    );

    const parsed = await Promise.all(
      files.map(async (f) => {
        const full = path.join(daemonDir, f);
        try {
          const [st, text] = await Promise.all([
            fs.promises.stat(full),
            fs.promises.readFile(full, "utf8"),
          ]);
          const payload = JSON.parse(text);
          if (!payload?.httpPort || !payload?.csrfToken) return null;
          const hasPid = typeof payload.pid === "number" && payload.pid > 0;
          const alive = hasPid ? isProcessAlive(payload.pid) : null;
          return {
            addr: `127.0.0.1:${payload.httpPort}`,
            csrfToken: String(payload.csrfToken),
            mtimeMs: st.mtimeMs,
            alive,
          };
        } catch {
          return null;
        }
      }),
    );

    const aliveList = parsed
      .filter((item) => item !== null && item.alive === true)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const unknownList = parsed
      .filter((item) => item !== null && item.alive === null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 2);

    for (const item of [...aliveList, ...unknownList]) {
      pushUnique(item.addr, item.csrfToken);
    }
  } catch {
    // daemon 目录不存在时静默忽略
  }

  return endpoints;
}

/**
 * 调用本地 Language Server 的 RefreshMcpServers 接口热重启指定 MCP 服务。
 * @param {string} serverName
 * @returns {Promise<{ refreshed: boolean; endpoint?: string; reason?: string }>}
 */
async function triggerMcpRefresh(serverName) {
  const endpoints = await discoverLiveLsEndpoints();
  if (endpoints.length === 0) {
    return { refreshed: false, reason: "未发现存活的 Antigravity Language Server 端点" };
  }

  let lastReason = "所有端点调用失败";
  for (const ep of endpoints) {
    const url = `http://${ep.addr}/exa.language_server_pb.LanguageServerService/RefreshMcpServers`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": ep.csrfToken,
        },
        body: JSON.stringify({ serverName }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
      if (res.ok) {
        return { refreshed: true, endpoint: ep.addr };
      }
      lastReason = `${ep.addr} 返回 HTTP ${res.status}`;
    } catch (err) {
      lastReason = `${ep.addr} 请求异常: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return { refreshed: false, reason: lastReason };
}

/**
 * 校验核心构建产物与待同步源文件均存在且非空，防止将损坏或不完整产物部署到线上目录。
 * @returns {Promise<void>}
 */
async function validateDeploySources() {
  for (const rel of DEPLOY_ENTRIES) {
    const abs = path.join(PROJECT_ROOT, rel);
    let st;
    try {
      st = await fs.promises.stat(abs);
    } catch {
      const hint = REQUIRED_BUILD_ARTIFACTS.includes(rel)
        ? "（请先执行 npm run build）"
        : "";
      throw new Error(`缺少待部署文件: ${rel}${hint}`);
    }
    if (!st.isFile() || st.size <= 0) {
      throw new Error(`待部署文件为空或非普通文件: ${rel}`);
    }
  }
}

/**
 * 将插件运行时必需文件同步至目标插件目录，并按需触发 Antigravity MCP 热重启。
 * @param {{ targetDir?: string; refreshMcp?: boolean }} [options]
 * @returns {Promise<{ copiedFiles: string[]; refreshed: boolean }>}
 */
export async function deployPlugin(options = {}) {
  const targetDir = path.resolve(options.targetDir || PLUGIN_DEPLOY_DIR);
  const refreshMcp = options.refreshMcp ?? true;

  // 1. 校验构建产物与配置完整非空
  await validateDeploySources();

  // 2. 逐项确保父目录存在并覆盖复制运行时必需文件
  /** @type {string[]} */
  const copiedFiles = [];
  for (const rel of DEPLOY_ENTRIES) {
    const src = path.join(PROJECT_ROOT, rel);
    const dest = path.join(targetDir, rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
    copiedFiles.push(rel);
  }

  console.log(`Deployed ${copiedFiles.length} runtime files to ${targetDir}:`);
  for (const rel of copiedFiles) {
    console.log(`  - ${rel}`);
  }

  // 3. 按需调用 RefreshMcpServers 通知宿主重载 MCP 服务
  let refreshed = false;
  if (refreshMcp) {
    const refreshResult = await triggerMcpRefresh(MCP_SERVER_NAME);
    refreshed = refreshResult.refreshed;
    if (refreshed) {
      console.log(`Refreshed MCP server "${MCP_SERVER_NAME}" via ${refreshResult.endpoint}`);
    } else {
      console.warn(
        `Warning: 文件已部署，但未能自动热重启 "${MCP_SERVER_NAME}" (${refreshResult.reason})`,
      );
    }
  }

  return { copiedFiles, refreshed };
}

/**
 * 解析命令行参数：支持 --target <dir> / --target=<dir> 与 --no-refresh。
 * @param {string[]} argv
 * @returns {{ targetDir?: string; refreshMcp: boolean }}
 */
function parseCliArgs(argv) {
  /** @type {{ targetDir?: string; refreshMcp: boolean }} */
  const opts = { refreshMcp: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-refresh") {
      opts.refreshMcp = false;
    } else if (arg === "--refresh") {
      opts.refreshMcp = true;
    } else if (arg === "--target" && argv[i + 1]) {
      opts.targetDir = argv[++i];
    } else if (arg.startsWith("--target=")) {
      opts.targetDir = arg.slice("--target=".length);
    }
  }
  return opts;
}

const isMainEntry =
  Boolean(process.argv[1]) &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMainEntry) {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  deployPlugin(cliOptions).catch((err) => {
    console.error("Deploy failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

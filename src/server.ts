import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchQuotaSummary } from "./quota.js";
import { SessionScanner } from "./scanner.js";

const APP_URI = "ui://context-monitor/app.html";
/** 宿主 listRoots() 最长等待时间，避免宿主阻塞拖死前端 3 秒刷新循环 */
const LIST_ROOTS_TIMEOUT_MS = 800;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML_PATH = path.resolve(__dirname, "app.html");

const scanner = new SessionScanner();

const server = new McpServer({
  name: "context-monitor",
  version: "0.3.0",
});

/**
 * 为异步操作附加超时保护，并在竞速结束后清理定时器防止句柄泄漏
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 解析当前工作区根目录：
 * 仅在宿主声明支持 roots 能力时请求 MCP Roots（外包 800ms 超时保护）；
 * 不再回退到 process.cwd()，避免桌面端共享 MCP 服务被启动目录永久锁死，
 * 空结果交由 resolveActiveWorkspace 基于当前打开的会话或用户手动选择工作区决策。
 */
async function resolveWorkspaceRoots(): Promise<{ paths: string[]; uris: string[] }> {
  const paths: string[] = [];
  const uris: string[] = [];

  const clientCaps = server.server.getClientCapabilities();
  if (clientCaps?.roots) {
    try {
      const res = await withTimeout(server.server.listRoots(), LIST_ROOTS_TIMEOUT_MS);
      for (const root of res.roots ?? []) {
        if (root.uri) {
          uris.push(root.uri);
          if (/^file:\/\//i.test(root.uri)) {
            try {
              const lowered = root.uri.replace(/^file:\/\//i, "file://");
              const fixedDrive = lowered.replace(/^file:\/\/\/([a-zA-Z])%3[aA](?=\/|$)/, "file:///$1:/");
              paths.push(fileURLToPath(fixedDrive));
            } catch {
              // 忽略非标准 file URI，由 workspace.ts 的 normalizeFileUri 处理
            }
          }
        }
      }
    } catch {
      // 宿主超时或返回错误时静默降级，交由当前活跃会话推断工作区
    }
  }

  return { paths, uris };
}

/**
 * 汇总会话扫描结果与各模型组限额摘要（含陈旧缓存标记）
 */
async function fetchSessionPayload(
  options: { limit?: number; forceRefresh?: boolean; workspaceFilter?: string } = {},
) {
  const limit = options.limit ?? 30;
  const { paths, uris } = await resolveWorkspaceRoots();
  const [scanResult, quotaResult] = await Promise.all([
    scanner.scan({
      workspacePaths: paths,
      workspaceUris: uris,
      limit,
      workspaceFilter: options.workspaceFilter,
    }),
    fetchQuotaSummary({ forceRefresh: Boolean(options.forceRefresh) }),
  ]);
  return {
    ...scanResult,
    quotas: quotaResult.groups,
    quotaStale: quotaResult.stale,
    quotaUpdatedAtMs: quotaResult.updatedAtMs,
  };
}

// 1. 注册供侧边栏 / 辅助面板 / 对话内打开的入口工具
server.registerTool(
  "open_context_monitor",
  {
    title: "Context Monitor",
    description:
      "Open the multi-session Antigravity Context Monitor dashboard to inspect active and inactive sessions, token usage, cache hit rate, and remaining context window.",
    inputSchema: {
      limit: z.number().int().min(1).max(80).optional().describe("Max number of recent sessions to scan"),
    },
    _meta: {
      ui: { resourceUri: APP_URI },
      "com.google.antigravity/ui": {
        entrypoints: [
          { type: "aux_pane", title: "Context Monitor" },
          { type: "global", title: "Context Monitor" },
        ],
      },
    },
  },
  async ({ limit }) => {
    const data = await fetchSessionPayload({ limit: limit ?? 30, forceRefresh: true });
    const runningCount = data.sessions.filter((s) => s.state === "running").length;
    const wsCount = data.sessions.filter((s) => s.matchesWorkspace).length;
    const totalCount = data.totalVisibleCount ?? data.sessions.length;
    const summary = `Scanned ${totalCount} sessions (${runningCount} running; ${wsCount} in "${data.workspaceLabel}").`;
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: data as unknown as Record<string, unknown>,
    };
  },
);

// 2. 注册仅限 UI App 调用的静默刷新工具（模型不可见）
server.registerTool(
  "list_sessions",
  {
    title: "List Sessions",
    description: "Fetch latest multi-session token metrics for the Context Monitor UI.",
    inputSchema: {
      limit: z.number().int().min(1).max(80).optional(),
      forceRefresh: z.boolean().optional(),
      workspaceFilter: z.string().optional(),
    },
    _meta: {
      ui: { visibility: ["app"] },
    },
  },
  async ({ limit, forceRefresh, workspaceFilter }) => {
    const data = await fetchSessionPayload({
      limit: limit ?? 30,
      forceRefresh: Boolean(forceRefresh),
      workspaceFilter,
    });
    return {
      content: [{ type: "text", text: "ok" }],
      structuredContent: data as unknown as Record<string, unknown>,
    };
  },
);

// 3. 注册打包后的单文件 HTML UI 资源（异步读取避免阻塞 stdio 事件循环）
server.registerResource(
  "Context Monitor App",
  APP_URI,
  {
    mimeType: "text/html;profile=mcp-app",
    _meta: {
      ui: { prefersBorder: false },
    },
  },
  async () => {
    const html = await fs.promises.readFile(APP_HTML_PATH, "utf8");
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: "text/html;profile=mcp-app",
          text: html,
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Context Monitor MCP server error:", err);
  process.exit(1);
});

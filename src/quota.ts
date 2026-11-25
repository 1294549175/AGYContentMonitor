import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface QuotaWindowInfo {
  remainingPct: number;
  resetTime: string;
}

export interface QuotaGroupSummary {
  id: string;
  label: string;
  fiveHour: QuotaWindowInfo | null;
  weekly: QuotaWindowInfo | null;
}

export interface FetchQuotaOptions {
  /** 是否强制绕过短周期缓存立即向 Language Server 拉取最新配额 */
  forceRefresh?: boolean;
}

export interface QuotaFetchResult {
  groups: QuotaGroupSummary[];
  /** 是否为上游瞬时失败时回退的陈旧缓存数据 */
  stale: boolean;
  /** 配额数据最后一次成功拉取的时间戳（毫秒），无数据时为 0 */
  updatedAtMs: number;
}

interface RawBucket {
  bucketId?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
}

interface RawGroup {
  displayName?: string;
  buckets?: RawBucket[];
}

interface LsEndpoint {
  addr: string;
  csrfToken: string;
}

interface HubFilePayload {
  pid?: number;
  httpPort?: number;
  csrfToken?: string;
}

const QUOTA_CACHE_TTL_MS = 15_000;
/** 兼容国内代理链路下的上游配额刷新延迟（原 1200ms 易偶发超时） */
const REQUEST_TIMEOUT_MS = 2_800;
/** 全部端点失败时允许保留的陈旧配额最长有效期（5 分钟），避免 UI 突然清空 */
const QUOTA_STALE_FALLBACK_TTL_MS = 5 * 60 * 1000;
/** 全部端点失败后的重试冷却期（10 秒），防止每 3 秒阻塞探测 */
const QUOTA_FAIL_BACKOFF_MS = 10_000;

let cachedEndpoint: LsEndpoint | null = null;
let cachedQuota: { data: QuotaGroupSummary[]; fetchedAtMs: number } | null = null;
let inFlightQuotaPromise: Promise<QuotaFetchResult> | null = null;
let lastFailureAtMs = 0;

/**
 * 清洗 Language Server 地址字符串：去除可能存在的 http(s):// 协议头与尾部斜杠，
 * 避免拼接请求 URL 时出现重复协议头（如 http://http://127.0.0.1:1234/）。
 */
export function normalizeLsAddr(rawAddr: string): string {
  return rawAddr
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

/**
 * 将上游模型组全称精简为紧凑的卡片标题，便于在侧栏小仪表盘中展示
 */
function shortenGroupLabel(displayName: string): string {
  const lower = displayName.toLowerCase();
  if (lower.includes("argon")) return "Argon";
  if (lower.includes("claude")) return "Claude / GPT";
  if (lower.includes("gemini")) return "Gemini";
  return displayName;
}

/**
 * 将原始限额桶转换为前端展示结构。
 * 注意：Protobuf3 JSON 序列化会省略值为 0 的浮点字段，因此只要 bucket 本身存在，
 * 缺省的 remainingFraction 应按 0（配额已耗尽）处理，避免 0% 时整行与重置倒计时消失。
 */
export function toWindowInfo(bucket: RawBucket | undefined): QuotaWindowInfo | null {
  if (!bucket || (!bucket.window && !bucket.bucketId)) return null;
  const rawFraction =
    typeof bucket.remainingFraction === "number" && Number.isFinite(bucket.remainingFraction)
      ? bucket.remainingFraction
      : 0;
  const clamped = Math.max(0, Math.min(1, rawFraction));
  return {
    remainingPct: Math.round(clamped * 1000) / 10,
    resetTime: bucket.resetTime || "",
  };
}

/**
 * 判断指定 PID 对应的进程当前是否存活（不发网络请求，避免被历史僵尸 hub 文件阻塞）
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // Windows / POSIX 下无权发信号但进程确实存在时会返回 EPERM
    return code === "EPERM";
  }
}

/**
 * 发现当前正在运行的 Antigravity Language Server 地址与 CSRF Token：
 * 1. 优先使用环境变量（若宿主注入）；
 * 2. 否则扫描 ~/.gemini/antigravity/daemon/hub_*.json，先用 PID 存活检测剔除已退出的残留文件，
 *    再按修改时间倒序排列，避免僵尸文件占满配额探测名额或造成超时卡顿。
 */
async function discoverLsEndpoints(): Promise<LsEndpoint[]> {
  const endpoints: LsEndpoint[] = [];
  const pushUnique = (ep: LsEndpoint) => {
    if (!endpoints.some((e) => e.addr === ep.addr && e.csrfToken === ep.csrfToken)) {
      endpoints.push(ep);
    }
  };

  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    const cleanAddr = normalizeLsAddr(process.env.ANTIGRAVITY_LS_ADDRESS);
    if (cleanAddr) {
      pushUnique({
        addr: cleanAddr,
        csrfToken: process.env.ANTIGRAVITY_CSRF_TOKEN,
      });
    }
  }

  const daemonDir = path.join(os.homedir(), ".gemini", "antigravity", "daemon");
  try {
    const files = (await fs.promises.readdir(daemonDir)).filter(
      (f) => f.startsWith("hub_") && f.endsWith(".json"),
    );

    const parsedItems = await Promise.all(
      files.map(async (f) => {
        const full = path.join(daemonDir, f);
        try {
          const [st, text] = await Promise.all([
            fs.promises.stat(full),
            fs.promises.readFile(full, "utf8"),
          ]);
          const payload = JSON.parse(text) as HubFilePayload;
          if (!payload.httpPort || !payload.csrfToken) return null;
          const hasPid = typeof payload.pid === "number" && payload.pid > 0;
          const alive = hasPid ? isProcessAlive(payload.pid as number) : null;
          return {
            addr: `127.0.0.1:${payload.httpPort}`,
            csrfToken: payload.csrfToken,
            mtimeMs: st.mtimeMs,
            alive,
          };
        } catch {
          // 忽略损坏或正在写入的 hub 文件
          return null;
        }
      }),
    );

    // 优先使用确认存活的进程，其次仅保留少量无 PID 字段的兜底项，完全跳过已确认退出的进程
    const aliveList = parsedItems
      .filter((x): x is NonNullable<typeof x> => x !== null && x.alive === true)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const unknownPidList = parsedItems
      .filter((x): x is NonNullable<typeof x> => x !== null && x.alive === null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 2);

    for (const item of [...aliveList, ...unknownPidList]) {
      pushUnique({ addr: item.addr, csrfToken: item.csrfToken });
    }
  } catch {
    // daemon 目录不存在时忽略
  }

  return endpoints;
}

/**
 * 向单个 Language Server 端点请求模型限额摘要并做结构规范化
 */
async function queryEndpoint(ep: LsEndpoint): Promise<QuotaGroupSummary[] | null> {
  const cleanAddr = normalizeLsAddr(ep.addr);
  if (!cleanAddr) return null;
  const url = `http://${cleanAddr}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-codeium-csrf-token": ep.csrfToken,
      },
      body: "{}",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as { response?: { groups?: RawGroup[] } };
    const groups = json?.response?.groups;
    if (!Array.isArray(groups)) return null;

    return groups
      .map((g, idx) => {
        const buckets = Array.isArray(g.buckets) ? g.buckets : [];
        const fiveHour = toWindowInfo(buckets.find((b) => b.window === "5h"));
        const weekly = toWindowInfo(buckets.find((b) => b.window === "weekly"));
        const label = shortenGroupLabel(g.displayName || `Group ${idx + 1}`);
        return {
          id: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${idx}`,
          label,
          fiveHour,
          weekly,
        };
      })
      .filter((g) => g.fiveHour !== null || g.weekly !== null);
  } catch {
    return null;
  }
}

/**
 * 在请求失败或处于失败冷却期时，决定返回 5 分钟内的陈旧缓存还是空结果
 */
function buildStaleOrEmptyResult(now: number): QuotaFetchResult {
  if (cachedQuota && now - cachedQuota.fetchedAtMs <= QUOTA_STALE_FALLBACK_TTL_MS) {
    return {
      groups: cachedQuota.data,
      stale: true,
      updatedAtMs: cachedQuota.fetchedAtMs,
    };
  }
  return {
    groups: [],
    stale: false,
    updatedAtMs: 0,
  };
}

/**
 * 内部单次探测流程：先尝试缓存的活跃端点，失败后重扫存活 hub_*.json；
 * 成功更新缓存并清零失败退避，全部失败则记录退避时间并返回 5 分钟内陈旧缓存。
 */
async function probeEndpointsOnce(
  queryFn: (ep: LsEndpoint) => Promise<QuotaGroupSummary[] | null>,
  discoverFn: () => Promise<LsEndpoint[]>,
): Promise<QuotaFetchResult> {
  const triedAddrs = new Set<string>();

  // 1. 优先复用上次成功的活跃端点
  if (cachedEndpoint) {
    triedAddrs.add(`${cachedEndpoint.addr}|${cachedEndpoint.csrfToken}`);
    const data = await queryFn(cachedEndpoint);
    if (data !== null) {
      const fetchedAtMs = Date.now();
      cachedQuota = { data, fetchedAtMs };
      lastFailureAtMs = 0;
      return { groups: data, stale: false, updatedAtMs: fetchedAtMs };
    }
    cachedEndpoint = null;
  }

  // 2. 缓存端点不可用时，重新扫描存活的 hub 端点
  const endpoints = await discoverFn();
  for (const ep of endpoints) {
    const cleanAddr = normalizeLsAddr(ep.addr);
    if (!cleanAddr) continue;
    const normalizedEp: LsEndpoint = { addr: cleanAddr, csrfToken: ep.csrfToken };
    const key = `${normalizedEp.addr}|${normalizedEp.csrfToken}`;
    if (triedAddrs.has(key)) continue;
    triedAddrs.add(key);

    const data = await queryFn(normalizedEp);
    if (data !== null) {
      const fetchedAtMs = Date.now();
      cachedEndpoint = normalizedEp;
      cachedQuota = { data, fetchedAtMs };
      lastFailureAtMs = 0;
      return { groups: data, stale: false, updatedAtMs: fetchedAtMs };
    }
  }

  const failedAt = Date.now();
  lastFailureAtMs = failedAt;
  return buildStaleOrEmptyResult(failedAt);
}

/**
 * 调用本地 Antigravity LanguageServer 获取各模型组的 5h 与周限额剩余可用量。
 * 特性：
 * 1. 15 秒正常短周期缓存；
 * 2. 并发请求去重（inFlightQuotaPromise）；
 * 3. 全部端点失败后 10 秒重试退避（避免每 3 秒阻塞探测）；
 * 4. 瞬时超时/失败时保留 5 分钟内有效缓存并标记 stale = true，防止顶部限额仪表突然消失。
 */
export async function fetchQuotaSummary(
  options: FetchQuotaOptions = {},
  deps?: {
    queryFn?: (ep: LsEndpoint) => Promise<QuotaGroupSummary[] | null>;
    discoverFn?: () => Promise<LsEndpoint[]>;
  },
): Promise<QuotaFetchResult> {
  const now = Date.now();
  const forceRefresh = Boolean(options.forceRefresh);

  if (!forceRefresh && lastFailureAtMs > 0 && now - lastFailureAtMs < QUOTA_FAIL_BACKOFF_MS) {
    return buildStaleOrEmptyResult(now);
  }

  if (!forceRefresh && cachedQuota && now - cachedQuota.fetchedAtMs < QUOTA_CACHE_TTL_MS) {
    return {
      groups: cachedQuota.data,
      stale: false,
      updatedAtMs: cachedQuota.fetchedAtMs,
    };
  }

  if (!forceRefresh && inFlightQuotaPromise) {
    return inFlightQuotaPromise;
  }

  const queryFn = deps?.queryFn ?? queryEndpoint;
  const discoverFn = deps?.discoverFn ?? discoverLsEndpoints;
  const promise = probeEndpointsOnce(queryFn, discoverFn);
  inFlightQuotaPromise = promise;

  try {
    return await promise;
  } finally {
    if (inFlightQuotaPromise === promise) {
      inFlightQuotaPromise = null;
    }
  }
}

/**
 * 仅供自动化测试重置模块级配额缓存与退避状态使用
 */
export function resetQuotaStateForTest(): void {
  cachedEndpoint = null;
  cachedQuota = null;
  inFlightQuotaPromise = null;
  lastFailureAtMs = 0;
}

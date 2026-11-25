import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod";

interface SessionItem {
  sessionId: string;
  shortId: string;
  title: string;
  activeContextTokens: number;
  freshInputTokens: number;
  cacheReadTokens: number;
  cacheHitPercent: number;
  lastOutputTokens: number;
  stepIndex: number;
  state: "running" | "idle";
  lastUpdatedMs: number;
  lastViewedMs: number;
  matchesWorkspace: boolean;
  projectId?: string;
  workspaceName?: string;
  workspaceKey?: string;
  compacted?: boolean;
  archived?: boolean;
  transcriptPath: string;
  transcriptUri: string;
}

interface WorkspaceOption {
  key: string;
  label: string;
  projectId: string | null;
  normalizedUris: string[];
  outsideOfProject: boolean;
  sessionCount: number;
}

interface QuotaWindowInfo {
  remainingPct: number;
  resetTime: string;
}

interface QuotaGroupSummary {
  id: string;
  label: string;
  fiveHour: QuotaWindowInfo | null;
  weekly: QuotaWindowInfo | null;
}

interface ScanPayload {
  sessions: SessionItem[];
  activeSessionId?: string | null;
  quotas?: QuotaGroupSummary[];
  quotaStale?: boolean;
  quotaUpdatedAtMs?: number;
  workspaceDetected: boolean;
  workspaceLabel: string;
  activeWorkspaceKey?: string;
  isPinnedWorkspace?: boolean;
  availableWorkspaces?: WorkspaceOption[];
  totalVisibleCount?: number;
  scannedAtMs: number;
}

interface CustomRequestCapableApp {
  request<T>(
    req: { method: string; params?: Record<string, unknown> },
    resultSchema: z.ZodType<T>,
  ): Promise<T>;
}

const app = new App({ name: "Context Monitor", version: "0.3.0" }, {});

let latestData: ScanPayload | null = null;
/** 用户偏好的展示范围；即使某次轮询瞬时未识别到工作区，也不永久覆写用户偏好 */
let preferredScope: "workspace" | "all" = "workspace";
/** 工作区过滤键："auto"（自动跟随）、"__all__"（全部会话）或具体 workspaceKey */
let selectedWorkspaceFilter = "auto";
let windowLimit = 240000;
let autoRefresh = true;
let refreshInFlight = false;
/** 当自动轮询飞行期间用户手动点击刷新时置 true，当前请求结束后立即补发强刷 */
let pendingForceRefresh = false;
/** 已渲染的最新 scannedAtMs，防止乱序旧回包覆盖新状态 */
let lastRenderedScannedAtMs = 0;
let lastQuotaSignature = "";
let lastWorkspaceSelectSignature = "";
let lastErrorText: string | null = null;
/** 记录当前宿主视图是否支持 aux-pane 打开日志（全屏 Global 视图通常不支持） */
let auxPaneSupported = true;

const wsSelect = document.getElementById("ws-select") as HTMLSelectElement;
const errorBannerEl = document.getElementById("error-banner") as HTMLDivElement;
const quotaStripEl = document.getElementById("quota-strip") as HTMLDivElement;
const summaryEl = document.getElementById("summary") as HTMLDivElement;
const listEl = document.getElementById("session-list") as HTMLDivElement;
const btnScopeWs = document.getElementById("btn-scope-ws") as HTMLButtonElement;
const btnScopeAll = document.getElementById("btn-scope-all") as HTMLButtonElement;
const windowSelect = document.getElementById("window-select") as HTMLSelectElement;
const btnAuto = document.getElementById("btn-auto") as HTMLButtonElement;
const btnRefresh = document.getElementById("btn-refresh") as HTMLButtonElement;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatRelativeTime(ms: number): string {
  if (!ms) return "-";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 15) return "刚刚";
  if (diffSec < 60) return `${diffSec}s 前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m 前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h 前`;
  return `${Math.floor(diffHr / 24)}d 前`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatResetCountdown(iso: string): string {
  if (!iso) return "";
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return "";
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "即将重置";
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "<1m";
  if (diffMin < 60) return `${diffMin}m`;
  const hrs = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  if (hrs < 24) return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

/**
 * 渲染顶部轻量错误提示条（连接失败或轮询出错时展示，不清空已有会话列表）
 */
function renderErrorBanner(): void {
  if (!lastErrorText) {
    errorBannerEl.classList.add("hidden");
    errorBannerEl.textContent = "";
    return;
  }
  errorBannerEl.classList.remove("hidden");
  errorBannerEl.textContent = lastErrorText;
}

/**
 * 渲染单个配额窗口进度条：颜色阈值与展示的整数百分比口径完全一致，
 * 消除如 19.6% 显示 20% 却仍标红的视觉错位。
 */
function renderQuotaRow(label: string, info: QuotaWindowInfo): string {
  const pct = Math.max(0, Math.min(100, info.remainingPct));
  const displayPct = Math.round(pct);
  const fillClass = displayPct < 20 ? "q-danger" : displayPct < 50 ? "q-warn" : "q-ok";
  const countdown = formatResetCountdown(info.resetTime);
  return `
    <div class="quota-row">
      <span>${label}${countdown ? ` (${countdown})` : ""}</span>
      <strong>${displayPct}%</strong>
    </div>
    <div class="quota-bar">
      <div class="quota-fill ${fillClass}" style="width: ${pct}%"></div>
    </div>
  `;
}

/**
 * 渲染顶部配额仪表条：带渲染指纹去重（数据与倒计时未变化时不重写 DOM），
 * 且在 stale=true 时展示低调的“缓存”提示。
 */
function renderQuotas(quotas: QuotaGroupSummary[] | undefined, stale: boolean): void {
  if (!quotas || quotas.length === 0) {
    if (lastQuotaSignature !== "EMPTY") {
      quotaStripEl.classList.add("hidden");
      quotaStripEl.innerHTML = "";
      lastQuotaSignature = "EMPTY";
    }
    return;
  }

  const sig = JSON.stringify({
    stale,
    items: quotas.map((q) => ({
      id: q.id,
      label: q.label,
      f: q.fiveHour
        ? [Math.round(q.fiveHour.remainingPct), formatResetCountdown(q.fiveHour.resetTime)]
        : null,
      w: q.weekly
        ? [Math.round(q.weekly.remainingPct), formatResetCountdown(q.weekly.resetTime)]
        : null,
    })),
  });
  if (sig === lastQuotaSignature) return;
  lastQuotaSignature = sig;

  quotaStripEl.classList.remove("hidden");
  quotaStripEl.innerHTML = quotas
    .map((q) => {
      const fiveHtml = q.fiveHour ? renderQuotaRow("5h", q.fiveHour) : "";
      const weeklyHtml = q.weekly ? renderQuotaRow("周限额", q.weekly) : "";
      const staleBadge = stale
        ? '<span class="quota-stale" title="上游请求瞬时超时，当前显示 5 分钟内缓存值">缓存</span>'
        : "";
      return `
        <div class="quota-card">
          <div class="quota-head">
            <div class="quota-name">${escapeHtml(q.label)}</div>
            ${staleBadge}
          </div>
          ${fiveHtml}
          ${weeklyHtml}
        </div>
      `;
    })
    .join("");
}

/**
 * 同步顶部工作区下拉选择器（自动跟随 / 各工作区 / 全部会话）：
 * 仅在选项集合或当前值变化且用户未聚焦下拉框时更新 DOM，避免打断菜单展开交互。
 */
function renderWorkspaceSelector(payload: ScanPayload): void {
  const options: Array<{ value: string; label: string }> = [];
  const autoLabel =
    !payload.isPinnedWorkspace && payload.workspaceDetected && payload.workspaceLabel
      ? `自动跟随 (${payload.workspaceLabel})`
      : "自动跟随";
  options.push({ value: "auto", label: autoLabel });

  const available = payload.availableWorkspaces ?? [];
  for (const w of available) {
    options.push({ value: w.key, label: `${w.label} (${w.sessionCount})` });
  }

  const totalCount = payload.totalVisibleCount ?? payload.sessions.length;
  options.push({ value: "__all__", label: `全部会话 (${totalCount})` });

  const desiredValue =
    preferredScope === "all" || selectedWorkspaceFilter === "__all__"
      ? "__all__"
      : selectedWorkspaceFilter;
  const effectiveValue = options.some((o) => o.value === desiredValue) ? desiredValue : "auto";

  const sig = JSON.stringify({ effectiveValue, options });
  if (sig === lastWorkspaceSelectSignature) return;
  // 若用户正在操作下拉框，暂缓重建选项，防止菜单自动收起
  if (document.activeElement === wsSelect) return;

  lastWorkspaceSelectSignature = sig;
  wsSelect.innerHTML = options
    .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
    .join("");
  wsSelect.value = effectiveValue;
  wsSelect.title = options.find((o) => o.value === effectiveValue)?.label || "切换工作区过滤";
}

/**
 * 生成单张会话卡片的内部 HTML（不含外层 .card 容器，用于按 data-session-id 局部刷新）
 */
function buildSessionCardInnerHtml(
  s: SessionItem,
  isCurrent: boolean,
  effectiveScope: "workspace" | "all",
  timeLabel: string,
): string {
  // 如实展示超过选定窗口上限的占用比例（进度条宽度仍封顶 100%）
  const usedPct = Math.round((s.activeContextTokens / windowLimit) * 1000) / 10;
  const barWidthPct = Math.min(100, Math.max(0, usedPct));
  const remainingTokens = Math.max(0, windowLimit - s.activeContextTokens);
  const remainingPct = Math.max(0, Math.round((100 - usedPct) * 10) / 10);
  const fillClass = usedPct >= 88 ? "fill-danger" : usedPct >= 70 ? "fill-warn" : "fill-ok";

  const compactedHtml = s.compacted
    ? '<span class="compacted-badge" title="已执行 /compact 压缩，当前为摘要估算值">已压缩估算</span>'
    : "";
  const wsTagHtml =
    effectiveScope === "all" && s.workspaceName
      ? `<span class="ws-tag" title="${escapeHtml(s.workspaceName)}">${escapeHtml(s.workspaceName)}</span>`
      : "";
  const logBtnHtml = auxPaneSupported
    ? `<button class="link-btn" data-uri="${escapeHtml(s.transcriptUri)}" type="button">查看日志</button>`
    : `<button class="link-btn" type="button" disabled title="全屏模式不支持侧栏打开文件，请在右侧辅助面板中使用">仅侧栏可看日志</button>`;

  return `
    <div class="card-top">
      <div class="card-title-wrap" title="${escapeHtml(s.title)}">
        <span class="dot ${s.state}"></span>
        ${isCurrent ? '<span class="current-badge">当前对话</span>' : ""}
        ${compactedHtml}
        ${wsTagHtml}
        <span class="card-title">${escapeHtml(s.title)}</span>
      </div>
      <div class="card-meta">
        <span class="mono">${escapeHtml(s.shortId)}</span>
        <span>·</span>
        <span>${s.state === "running" ? "运行中" : "空闲"}</span>
        <span>·</span>
        <span class="card-time" data-ts="${Math.max(s.lastUpdatedMs, s.lastViewedMs)}">${timeLabel}</span>
      </div>
    </div>

    <div class="progress-row">
      <span>已用 <strong>${formatTokens(s.activeContextTokens)}</strong> (${usedPct}%)</span>
      <span>剩余 <strong>${formatTokens(remainingTokens)}</strong> (${remainingPct}%)</span>
    </div>
    <div class="progress-track">
      <div class="progress-fill ${fillClass}" style="width: ${barWidthPct}%"></div>
    </div>

    <div class="metrics">
      <div class="metrics-left">
        <span>Fresh: ${formatTokens(s.freshInputTokens)}</span>
        <span>Cache: ${formatTokens(s.cacheReadTokens)} (${s.cacheHitPercent}%)</span>
        <span>Out: ${formatTokens(s.lastOutputTokens)}</span>
        <span>Step #${s.stepIndex}</span>
      </div>
      ${logBtnHtml}
    </div>
  `;
}

/**
 * 按 data-session-id 增量更新会话卡片列表：
 * 数据未变化的卡片完全跳过 DOM 重写，保留用户划词选择、悬停提示与进度条动画。
 */
function renderSessionList(
  visible: SessionItem[],
  activeSessionId: string | null | undefined,
  effectiveScope: "workspace" | "all",
): void {
  if (visible.length === 0) {
    if (listEl.dataset.empty !== "1") {
      listEl.dataset.empty = "1";
      listEl.innerHTML = `
        <div class="empty">
          当前过滤条件下暂无会话。<br/>
          可在左上角切换工作区，或点击 <strong>全部会话</strong> 查看本机所有 Antigravity 对话。
        </div>
      `;
    }
    return;
  }

  if (listEl.dataset.empty === "1") {
    listEl.dataset.empty = "0";
    listEl.innerHTML = "";
  }

  const existingById = new Map<string, HTMLDivElement>();
  for (const child of Array.from(listEl.children)) {
    const el = child as HTMLDivElement;
    const sid = el.dataset.sessionId;
    if (sid) {
      existingById.set(sid, el);
    } else {
      el.remove();
    }
  }

  const nextIds = new Set<string>();
  const orderedNodes: HTMLDivElement[] = [];

  for (const s of visible) {
    nextIds.add(s.sessionId);
    const isCurrent = Boolean(activeSessionId && s.sessionId === activeSessionId);
    const timeMs = Math.max(s.lastUpdatedMs, s.lastViewedMs);
    const timeLabel = formatRelativeTime(timeMs);

    const cardSig = [
      s.title,
      s.state,
      s.activeContextTokens,
      s.freshInputTokens,
      s.cacheReadTokens,
      s.cacheHitPercent,
      s.lastOutputTokens,
      s.stepIndex,
      s.compacted ? "1" : "0",
      isCurrent ? "1" : "0",
      effectiveScope,
      s.workspaceName || "",
      auxPaneSupported ? "1" : "0",
      windowLimit,
      timeLabel,
    ].join("|");

    let cardEl = existingById.get(s.sessionId);
    if (!cardEl) {
      cardEl = document.createElement("div");
      cardEl.dataset.sessionId = s.sessionId;
    }

    const cardClasses = ["card"];
    if (s.state === "running") cardClasses.push("running");
    if (isCurrent) cardClasses.push("current");
    const nextClassName = cardClasses.join(" ");
    if (cardEl.className !== nextClassName) {
      cardEl.className = nextClassName;
    }

    if (cardEl.dataset.sig !== cardSig) {
      cardEl.dataset.sig = cardSig;
      cardEl.innerHTML = buildSessionCardInnerHtml(s, isCurrent, effectiveScope, timeLabel);
    }

    orderedNodes.push(cardEl);
  }

  // 移除已不再可见的旧卡片
  for (const [sid, el] of existingById.entries()) {
    if (!nextIds.has(sid)) {
      el.remove();
    }
  }

  // 仅在顺序不一致或新增节点时执行最小化 DOM 插入
  for (let i = 0; i < orderedNodes.length; i++) {
    const desired = orderedNodes[i];
    const currentAtPos = listEl.children[i];
    if (currentAtPos !== desired) {
      listEl.insertBefore(desired, currentAtPos ?? null);
    }
  }
}

/**
 * 独立轻量刷新各卡片相对时间文案，与 3 秒数据轮询解耦
 */
function refreshRelativeTimestamps(): void {
  const timeNodes = listEl.querySelectorAll<HTMLSpanElement>(".card-time[data-ts]");
  for (const node of Array.from(timeNodes)) {
    const ts = Number(node.dataset.ts) || 0;
    const nextText = formatRelativeTime(ts);
    if (node.textContent !== nextText) {
      node.textContent = nextText;
    }
  }
}

function render(): void {
  renderErrorBanner();
  if (!latestData) return;

  const { sessions, activeSessionId, quotas, quotaStale, workspaceDetected } = latestData;
  renderQuotas(quotas, Boolean(quotaStale));
  renderWorkspaceSelector(latestData);

  // 未识别工作区或手动选为全部会话时展示全部；否则按工作区过滤
  const effectiveScope: "workspace" | "all" =
    selectedWorkspaceFilter === "__all__"
      ? "all"
      : workspaceDetected || selectedWorkspaceFilter !== "auto"
        ? preferredScope
        : "all";

  btnScopeWs.disabled = !workspaceDetected && selectedWorkspaceFilter === "auto";
  btnScopeWs.classList.toggle("active", effectiveScope === "workspace");
  btnScopeAll.classList.toggle("active", effectiveScope === "all");

  // 本地同步过滤：用户切换具体工作区后在后端回包前也能即时响应
  const visible =
    effectiveScope === "all"
      ? sessions
      : selectedWorkspaceFilter !== "auto" &&
          selectedWorkspaceFilter !== "__all__" &&
          latestData.activeWorkspaceKey !== selectedWorkspaceFilter
        ? sessions.filter((s) => s.workspaceKey === selectedWorkspaceFilter)
        : sessions.filter((s) => s.matchesWorkspace);

  const runningCount = visible.filter((s) => s.state === "running").length;
  const maxUsed = visible.reduce((acc, s) => Math.max(acc, s.activeContextTokens), 0);
  const maxPct = Math.round((maxUsed / windowLimit) * 100);
  const totalCount = latestData.totalVisibleCount ?? sessions.length;

  summaryEl.innerHTML = `
    <span class="summary-item">显示会话: <strong>${visible.length}</strong> / ${totalCount}</span>
    <span class="summary-item">运行中: <strong>${runningCount}</strong></span>
    <span class="summary-item">最高占用: <strong>${formatTokens(maxUsed)}</strong> (${maxPct}%)</span>
    <span class="summary-item">更新于: ${new Date(latestData.scannedAtMs).toLocaleTimeString()}</span>
  `;

  renderSessionList(visible, activeSessionId, effectiveScope);
}

/**
 * 接收并应用最新扫描回包（校验 scannedAtMs 单调性，防止乱序旧回包覆盖新数据）
 */
function applyPayload(payload: ScanPayload): void {
  if (payload.scannedAtMs && payload.scannedAtMs < lastRenderedScannedAtMs) {
    return;
  }
  if (payload.scannedAtMs) {
    lastRenderedScannedAtMs = payload.scannedAtMs;
  }
  latestData = payload;
  lastErrorText = null;
  render();
}

/**
 * 拉取最新会话与配额数据：
 * 1. 若自动刷新正在飞行期间用户手动点击刷新，置 pendingForceRefresh=true 并在结束后立即补刷；
 * 2. 携带当前选中的 workspaceFilter；
 * 3. 请求失败时展示轻量错误提示条并保留既有列表。
 */
async function fetchLatest(forceRefresh = false): Promise<void> {
  if (refreshInFlight) {
    if (forceRefresh) {
      pendingForceRefresh = true;
    }
    return;
  }

  refreshInFlight = true;
  if (forceRefresh) {
    btnRefresh.disabled = true;
    btnRefresh.textContent = "刷新中...";
  }

  try {
    const res = await app.callServerTool({
      name: "list_sessions",
      arguments: {
        limit: 30,
        forceRefresh,
        workspaceFilter: selectedWorkspaceFilter,
      },
    });
    if (res?.structuredContent) {
      applyPayload(res.structuredContent as unknown as ScanPayload);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastErrorText = `刷新失败（已保留上次数据）：${msg || "与插件服务通信中断"}`;
    renderErrorBanner();
  } finally {
    refreshInFlight = false;
    btnRefresh.disabled = false;
    btnRefresh.textContent = "刷新";
    if (pendingForceRefresh) {
      pendingForceRefresh = false;
      void fetchLatest(true);
    }
  }
}

/**
 * 类型安全地调用 Antigravity 自定义 aux-pane 文件打开 RPC（避免 TS2322 联合类型报错）
 */
async function requestToggleAuxPane(uri: string): Promise<{ isError?: boolean }> {
  const customApp = app as unknown as CustomRequestCapableApp;
  return customApp.request(
    {
      method: "com.google.antigravity/toggle-aux-pane",
      params: { tabType: "fileView", uri },
    },
    z.object({ isError: z.boolean().optional() }).passthrough(),
  );
}

/**
 * 判断捕获的 RPC 异常是否为宿主不支持方法（JSON-RPC -32601 Method not found）
 */
function isMethodNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === -32601) return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" && (msg.includes("-32601") || /method not found/i.test(msg));
}

/**
 * 在单个日志按钮上临时提示“打开失败”2 秒后恢复，不误伤其他会话的日志按钮
 */
function flashButtonError(btn: HTMLButtonElement, label = "打开失败"): void {
  const prevText = btn.textContent || "查看日志";
  btn.textContent = label;
  btn.classList.add("err");
  btn.disabled = true;
  window.setTimeout(() => {
    if (!btn.isConnected || !auxPaneSupported) return;
    btn.textContent = prevText;
    btn.classList.remove("err");
    btn.disabled = false;
  }, 2000);
}

// 事件绑定
wsSelect.addEventListener("change", () => {
  const val = wsSelect.value || "auto";
  selectedWorkspaceFilter = val;
  preferredScope = val === "__all__" ? "all" : "workspace";
  render();
  void fetchLatest(false);
});

btnScopeWs.addEventListener("click", () => {
  preferredScope = "workspace";
  if (selectedWorkspaceFilter === "__all__") {
    selectedWorkspaceFilter = "auto";
    void fetchLatest(false);
  }
  render();
});

btnScopeAll.addEventListener("click", () => {
  preferredScope = "all";
  selectedWorkspaceFilter = "__all__";
  render();
});

windowSelect.addEventListener("change", () => {
  windowLimit = Number(windowSelect.value) || 240000;
  render();
});

btnAuto.addEventListener("click", () => {
  autoRefresh = !autoRefresh;
  btnAuto.textContent = `自动刷新: ${autoRefresh ? "开" : "关"}`;
});

btnRefresh.addEventListener("click", () => {
  void fetchLatest(true);
});

listEl.addEventListener("click", async (evt) => {
  const target = evt.target as HTMLElement | null;
  const btn = target?.closest("button[data-uri]") as HTMLButtonElement | null;
  if (!btn || btn.disabled) return;
  const uri = btn.dataset.uri;
  if (!uri) return;
  try {
    const result = await requestToggleAuxPane(uri);
    if (result?.isError) {
      // 单文件打开失败（例如日志不存在或路径无效）仅提示当前按钮，不禁用全局
      flashButtonError(btn, "打开失败");
    }
  } catch (err) {
    if (isMethodNotFoundError(err)) {
      // 仅当宿主明确返回 -32601（不支持 aux-pane）时全局降级按钮状态
      auxPaneSupported = false;
      render();
    } else {
      flashButtonError(btn, "打开失败");
    }
  }
});

// 必须在 connect() 前注册回调，避免错过首次结果或主题通知
app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    applyPayload(result.structuredContent as unknown as ScanPayload);
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function init(): Promise<void> {
  try {
    await app.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastErrorText = `无法连接到宿主环境：${msg || "连接超时"}，请尝试重新打开面板。`;
    renderErrorBanner();
    return;
  }

  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);

  // 通过宿主能力预检：无 message 且无 updateModelContext 通常为 Global View，预先标记不支持侧栏打开日志
  const hostCaps = app.getHostCapabilities();
  if (hostCaps && !hostCaps.message && !hostCaps.updateModelContext) {
    auxPaneSupported = false;
  }

  if (!latestData) {
    await fetchLatest(false);
  } else {
    render();
  }

  // 3 秒数据轮询与 15 秒相对时间轻量刷新解耦
  window.setInterval(() => {
    if (autoRefresh) {
      void fetchLatest(false);
    }
  }, 3000);

  window.setInterval(() => {
    refreshRelativeTimestamps();
  }, 15_000);
}

void init();

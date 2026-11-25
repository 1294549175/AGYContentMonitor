import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ActiveWorkspace,
  buildEncodedUriNeedles,
  collectAvailableWorkspaces,
  fileContainsAnyFallback,
  getAgyRoot,
  isOutsideOfProjectSummary,
  loadConversationIndex,
  loadProjectRegistry,
  resolveActiveWorkspace,
  resolveSessionWorkspaceKey,
  resolveSessionWorkspaceName,
  SummaryRecord,
  WorkspaceOption,
} from "./workspace.js";

export interface SessionInfo {
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
  projectId: string;
  workspaceName: string;
  /** 该会话对应的稳定工作区键，与 WorkspaceOption.key 对齐 */
  workspaceKey: string;
  /** 最近一条有效上下文事件是否为 CHECKPOINT 压缩估算值 */
  compacted?: boolean;
  archived: boolean;
  transcriptPath: string;
  transcriptUri: string;
}

export interface ScanOptions {
  workspacePaths: string[];
  workspaceUris: string[];
  limit?: number;
  includeArchived?: boolean;
  /** 手动工作区过滤键："auto" | "__all__" | 具体 workspaceKey */
  workspaceFilter?: string;
}

export interface ScanResult {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  workspaceDetected: boolean;
  workspaceLabel: string;
  activeWorkspaceKey: string;
  isPinnedWorkspace: boolean;
  availableWorkspaces: WorkspaceOption[];
  totalVisibleCount: number;
  scannedAtMs: number;
}

export interface AnnotationMeta {
  title: string | null;
  viewMs: number;
  annMtimeMs: number;
  archived: boolean;
  /** 从 annotations/*.pbtxt 的 side_question_cascade_ids 提取的侧边提问子会话 ID */
  sideQuestionIds: string[];
}

export interface ParsedTranscript {
  title: string;
  hasTitle: boolean;
  activeContextTokens: number;
  freshInputTokens: number;
  cacheReadTokens: number;
  lastOutputTokens: number;
  stepIndex: number;
  /** 日志末尾是否停留在待回复/待工具返回状态（用于无 summary 记录时的降级判断） */
  lastEntryRunning: boolean;
  /** 最近一次上下文统计是否来自 CHECKPOINT 压缩重置 */
  compacted: boolean;
}

export interface TranscriptCacheEntry {
  mtimeMs: number;
  size: number;
  byteOffset: number;
  partialLine: string;
  parsed: ParsedTranscript;
}

export interface RootCandidate {
  id: string;
  transcriptPath: string;
  mtimeMs: number;
  size: number;
  viewMs: number;
  annMtimeMs: number;
  annTitle: string | null;
  archived: boolean;
  score: number;
  summary: SummaryRecord | undefined;
}

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const STALE_RUNNING_MS = 2 * 60 * 1000;
const DEFAULT_STALE_RUNNING_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_TRANSCRIPT_CACHE_SIZE = 256;

function getBrainDir(): string {
  return path.join(getAgyRoot(), "brain");
}

function getAnnotationsDir(): string {
  return path.join(getAgyRoot(), "annotations");
}

function getConversationsDir(): string {
  return path.join(getAgyRoot(), "conversations");
}

function transcriptPathFor(convId: string): string {
  return path.join(getBrainDir(), convId, ".system_generated", "logs", "transcript.jsonl");
}

/**
 * 使用 Node 标准 pathToFileURL 将本地路径转为合规 file:// URI，正确编码空格与非 ASCII 字符
 */
function toFileUri(filePath: string): string {
  try {
    return pathToFileURL(filePath).href;
  } catch {
    const normalized = filePath.replace(/\\/g, "/");
    return /^[a-zA-Z]:\//.test(normalized) ? `file:///${normalized}` : `file://${normalized}`;
  }
}

async function statSafe(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

async function readdirSafe(p: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(p);
  } catch {
    return [];
  }
}

async function readHead(filePath: string, bytes: number): Promise<string> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

function cleanUserTitle(raw: string): string {
  const stripped = raw
    .replace(/<\/?USER_REQUEST>/gi, " ")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "Untitled session";
  return stripped.length > 72 ? `${stripped.slice(0, 72)}...` : stripped;
}

/**
 * 创建空的 transcript 解析初始状态
 */
function createEmptyParsedTranscript(): ParsedTranscript {
  return {
    title: "Untitled session",
    hasTitle: false,
    activeContextTokens: 0,
    freshInputTokens: 0,
    cacheReadTokens: 0,
    lastOutputTokens: 0,
    stepIndex: 0,
    lastEntryRunning: false,
    compacted: false,
  };
}

/**
 * 校验并解析 step_index 字段，避免 null / "" / undefined 被 Number() 静默转成 0
 */
function parseValidStepIndex(raw: unknown, fallbackNext: number): number {
  if (raw === undefined || raw === null || raw === "") {
    return fallbackNext;
  }
  const num = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(num) ? num : fallbackNext;
}

/**
 * 快速判断 JSONL 行是否可能为关注的事件类型，跳过海量 GENERIC 工具输出行的 JSON.parse
 */
function mayContainTrackedEvent(line: string): boolean {
  return (
    line.includes("PLANNER_RESPONSE") ||
    line.includes("USER_INPUT") ||
    line.includes("CHECKPOINT") ||
    line.includes("ERROR_MESSAGE")
  );
}

/**
 * 将单条解析后的 transcript JSON 记录增量合并到当前指标状态中
 */
function applyTranscriptEntry(state: ParsedTranscript, entry: Record<string, unknown>): void {
  const type = entry.type;
  if (type === "USER_INPUT") {
    state.lastEntryRunning = true;
    if (!state.hasTitle && typeof entry.content === "string" && entry.content.trim()) {
      state.title = cleanUserTitle(entry.content);
      state.hasTitle = true;
    }
    return;
  }

  if (type === "PLANNER_RESPONSE") {
    const inTokens = Number(entry.input_tokens) || 0;
    const cacheTokens = Number(entry.cache_read_tokens) || 0;
    const outTokens = Number(entry.output_tokens) || 0;
    if (inTokens + cacheTokens > 0) {
      state.activeContextTokens = inTokens + cacheTokens;
      state.freshInputTokens = inTokens;
      state.cacheReadTokens = cacheTokens;
      state.lastOutputTokens = outTokens;
      state.compacted = false;
    }
    state.stepIndex = parseValidStepIndex(entry.step_index, state.stepIndex + 1);

    const statusStr = typeof entry.status === "string" ? entry.status.toUpperCase() : "";
    const isTerminalError =
      statusStr.includes("ERROR") || statusStr.includes("CANCEL") || statusStr.includes("FAIL");
    state.lastEntryRunning =
      !isTerminalError && Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0;
    return;
  }

  if (type === "CHECKPOINT") {
    // /compact 压缩生成的 CHECKPOINT：以上下文摘要的 output_tokens 重置当前有效上下文估算值
    const outTokens = Number(entry.output_tokens) || 0;
    state.activeContextTokens = outTokens;
    state.freshInputTokens = outTokens;
    state.cacheReadTokens = 0;
    state.lastOutputTokens = outTokens;
    state.compacted = true;
    state.stepIndex = parseValidStepIndex(entry.step_index, state.stepIndex + 1);
    state.lastEntryRunning = false;
    return;
  }

  if (type === "ERROR_MESSAGE") {
    // 遇到错误中断后应立即清除残留运行标记，避免误报 2 分钟“运行中”
    state.lastEntryRunning = false;
  }
}

/**
 * 读取文件从 startOffset 到 endOffset 之间的 UTF-8 文本片段
 */
async function readRangeUtf8(
  filePath: string,
  startOffset: number,
  endOffset: number,
): Promise<{ text: string; bytesRead: number }> {
  const toRead = Math.max(0, endOffset - startOffset);
  if (toRead === 0) return { text: "", bytesRead: 0 };

  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, "r");
    const buf = Buffer.alloc(toRead);
    let totalRead = 0;
    while (totalRead < toRead) {
      const { bytesRead } = await fd.read(buf, totalRead, toRead - totalRead, startOffset + totalRead);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    return { text: buf.toString("utf8", 0, totalRead), bytesRead: totalRead };
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

/**
 * 增量解析单个会话的 transcript.jsonl，提取标题、最新上下文 Token、压缩标记与步数。
 * 1. mtimeMs 与 size 均未变化时刷新 LRU 位置并零 IO 返回；
 * 2. 文件发生追加增长时仅读取 [byteOffset, size) 新增字节并基于旧状态增量推进；
 * 3. 支持 CHECKPOINT 压缩重置，并对非关注事件行做前缀快筛避免多余 JSON.parse。
 */
export async function parseTranscriptMetrics(
  transcriptPath: string,
  mtimeMs: number,
  size: number,
  cache: Map<string, TranscriptCacheEntry>,
): Promise<ParsedTranscript> {
  const hit = cache.get(transcriptPath);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
    // 维护真正的 LRU 顺序：命中后移至 Map 末尾
    cache.delete(transcriptPath);
    cache.set(transcriptPath, hit);
    return hit.parsed;
  }

  const canIncremental = Boolean(hit && size > hit.size && hit.byteOffset <= size);
  const startOffset = canIncremental ? hit!.byteOffset : 0;
  const state: ParsedTranscript = canIncremental
    ? { ...hit!.parsed }
    : createEmptyParsedTranscript();
  const prevPartial = canIncremental ? hit!.partialLine : "";

  let chunkText = "";
  let bytesRead = 0;
  try {
    if (startOffset === 0) {
      const rawBuf = await fs.promises.readFile(transcriptPath);
      bytesRead = rawBuf.length;
      chunkText = rawBuf.toString("utf8");
    } else {
      const res = await readRangeUtf8(transcriptPath, startOffset, size);
      chunkText = res.text;
      bytesRead = res.bytesRead;
    }
  } catch {
    return hit ? hit.parsed : createEmptyParsedTranscript();
  }

  const combined = prevPartial + chunkText;
  const endsWithNewline = combined.endsWith("\n");
  const lines = combined.split(/\r?\n/);
  let nextPartialLine = "";
  if (!endsWithNewline) {
    nextPartialLine = lines.pop() ?? "";
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !mayContainTrackedEvent(trimmed)) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      applyTranscriptEntry(state, entry);
    } catch {
      // 忽略损坏行
    }
  }

  // 若末行无尾随换行符但本身已是完整 JSON，则立即消费它，防止漏掉最新一条记录
  if (nextPartialLine) {
    const trimmedTail = nextPartialLine.trim();
    if (!trimmedTail) {
      nextPartialLine = "";
    } else {
      try {
        const entry = JSON.parse(trimmedTail) as Record<string, unknown>;
        if (mayContainTrackedEvent(trimmedTail)) {
          applyTranscriptEntry(state, entry);
        }
        nextPartialLine = "";
      } catch {
        // 确实是尚未写完的半截行，留待下次追加补齐
      }
    }
  }

  const nextEntry: TranscriptCacheEntry = {
    mtimeMs,
    size,
    byteOffset: startOffset + bytesRead,
    partialLine: nextPartialLine,
    parsed: state,
  };

  cache.delete(transcriptPath);
  if (cache.size >= MAX_TRANSCRIPT_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(transcriptPath, nextEntry);
  return state;
}

/**
 * 单次扫描还原 protobuf text format 字符串字面量中的转义序列：
 * 支持 \"、\'、\\、\n、\r、\t，以及连续八进制字节转义（如 \346\243\200）和 \xHH 的 UTF-8 还原。
 */
export function unescapePbtxtString(raw: string): string {
  const parts: string[] = [];
  const byteBuf: number[] = [];

  const flushBytes = () => {
    if (byteBuf.length > 0) {
      parts.push(Buffer.from(byteBuf).toString("utf8"));
      byteBuf.length = 0;
    }
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== "\\" || i + 1 >= raw.length) {
      flushBytes();
      parts.push(ch);
      i += 1;
      continue;
    }

    const next = raw[i + 1];
    // 1~3 位八进制字节转义（protobuf text format 输出非 ASCII UTF-8 的常见形式）
    if (next >= "0" && next <= "7") {
      let oct = next;
      let consumed = 2;
      if (i + 2 < raw.length && raw[i + 2] >= "0" && raw[i + 2] <= "7") {
        oct += raw[i + 2];
        consumed = 3;
        if (i + 3 < raw.length && raw[i + 3] >= "0" && raw[i + 3] <= "7") {
          oct += raw[i + 3];
          consumed = 4;
        }
      }
      byteBuf.push(parseInt(oct, 8) & 0xff);
      i += consumed;
      continue;
    }

    if ((next === "x" || next === "X") && i + 3 < raw.length) {
      const hex = raw.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        byteBuf.push(parseInt(hex, 16) & 0xff);
        i += 4;
        continue;
      }
    }

    flushBytes();
    switch (next) {
      case '"':
        parts.push('"');
        break;
      case "'":
        parts.push("'");
        break;
      case "\\":
        parts.push("\\");
        break;
      case "n":
        parts.push("\n");
        break;
      case "r":
        parts.push("\r");
        break;
      case "t":
        parts.push("\t");
        break;
      default:
        parts.push(next);
        break;
    }
    i += 2;
  }

  flushBytes();
  return parts.join("");
}

/**
 * 使用引号感知的轻量词法扫描解析 .pbtxt 顶层字段，
 * 避免标题文本中出现 `archived: true` 或 `last_user_view_time:` 造成正则误匹配。
 */
export function parseAnnotationMetaFromText(
  text: string,
  fallbackMtimeMs: number,
): AnnotationMeta {
  let title: string | null = null;
  let viewMs = 0;
  let archived = false;
  const sideQuestionIdSet = new Set<string>();

  const len = text.length;
  let i = 0;

  const skipWsAndComments = () => {
    while (i < len) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "," || c === ";") {
        i += 1;
      } else if (c === "#") {
        while (i < len && text[i] !== "\n") i += 1;
      } else {
        break;
      }
    }
  };

  const readQuotedString = (): string => {
    const quote = text[i];
    i += 1;
    const start = i;
    while (i < len) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
      } else if (c === quote) {
        const raw = text.slice(start, i);
        i += 1;
        return unescapePbtxtString(raw);
      } else {
        i += 1;
      }
    }
    return unescapePbtxtString(text.slice(start));
  };

  /** 读取可能相邻拼接的多个 protobuf 字符串字面量（如 "foo" "bar"） */
  const readConcatenatedString = (): string => {
    let out = readQuotedString();
    while (true) {
      const saved = i;
      skipWsAndComments();
      if (i < len && (text[i] === '"' || text[i] === "'")) {
        out += readQuotedString();
      } else {
        i = saved;
        break;
      }
    }
    return out;
  };

  const readBalancedBlock = (openChar: string, closeChar: string): string => {
    i += 1; // 跳过 openChar
    const start = i;
    let depth = 1;
    while (i < len && depth > 0) {
      const c = text[i];
      if (c === '"' || c === "'") {
        readQuotedString();
      } else if (c === "#") {
        while (i < len && text[i] !== "\n") i += 1;
      } else if (c === openChar) {
        depth += 1;
        i += 1;
      } else if (c === closeChar) {
        depth -= 1;
        if (depth === 0) {
          const inner = text.slice(start, i);
          i += 1;
          return inner;
        }
        i += 1;
      } else {
        i += 1;
      }
    }
    return text.slice(start);
  };

  while (i < len) {
    skipWsAndComments();
    if (i >= len) break;

    // 读取顶层字段名
    const keyStart = i;
    while (i < len && /[a-zA-Z0-9_]/.test(text[i])) i += 1;
    const key = text.slice(keyStart, i);
    if (!key) {
      // 遇到非标识符字符时安全前进，防止死循环
      if (text[i] === '"' || text[i] === "'") {
        readQuotedString();
      } else if (text[i] === "{") {
        readBalancedBlock("{", "}");
      } else if (text[i] === "[") {
        readBalancedBlock("[", "]");
      } else {
        i += 1;
      }
      continue;
    }

    skipWsAndComments();
    if (i < len && text[i] === ":") {
      i += 1;
      skipWsAndComments();
    }
    if (i >= len) break;

    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const strVal = readConcatenatedString();
      if (key === "title") {
        const cleaned = strVal.trim();
        if (cleaned) title = cleaned;
      } else if (key === "side_question_cascade_ids") {
        const cleaned = strVal.trim();
        if (cleaned) sideQuestionIdSet.add(cleaned);
      }
    } else if (ch === "{") {
      const block = readBalancedBlock("{", "}");
      if (key === "last_user_view_time") {
        // 兼容 seconds 与 nanos 任意先后顺序
        const secMatch = /\bseconds\s*:\s*(\d+)/.exec(block);
        const nanosMatch = /\bnanos\s*:\s*(\d+)/.exec(block);
        if (secMatch) {
          const sec = Number(secMatch[1]) || 0;
          const nanos = nanosMatch ? Number(nanosMatch[1]) || 0 : 0;
          viewMs = sec * 1000 + Math.floor(nanos / 1e6);
        }
      }
    } else if (ch === "[") {
      const listInner = readBalancedBlock("[", "]");
      if (key === "side_question_cascade_ids") {
        const strRe = /"((?:[^"\\]|\\.)*)"/g;
        let m: RegExpExecArray | null;
        while ((m = strRe.exec(listInner)) !== null) {
          const cleaned = unescapePbtxtString(m[1]).trim();
          if (cleaned) sideQuestionIdSet.add(cleaned);
        }
      }
    } else {
      const valStart = i;
      while (i < len && !/[\s,;{}[\]#]/.test(text[i])) i += 1;
      const scalar = text.slice(valStart, i);
      if (key === "archived") {
        archived = scalar === "true";
      }
    }
  }

  return {
    title,
    viewMs,
    annMtimeMs: fallbackMtimeMs,
    archived,
    sideQuestionIds: [...sideQuestionIdSet],
  };
}

/**
 * 从 annotations/<id>.pbtxt 中提取会话标题、最后查看时间、归档标记与侧边提问子会话 ID
 */
export async function parseAnnotationMeta(
  annPath: string,
  fallbackMtimeMs: number,
): Promise<AnnotationMeta> {
  try {
    const text = await fs.promises.readFile(annPath, "utf8");
    return parseAnnotationMetaFromText(text, fallbackMtimeMs);
  } catch {
    return {
      title: null,
      viewMs: 0,
      annMtimeMs: fallbackMtimeMs,
      archived: false,
      sideQuestionIds: [],
    };
  }
}

/**
 * 综合 conversation_summaries.db 的实时状态与日志兜底推断，判定会话是否处于运行中。
 * 增加 staleRunningMaxAgeMs（默认 15 分钟）上限，防止宿主异常崩溃残留 RUNNING 状态永久卡住。
 */
export function resolveSessionState(
  summary: SummaryRecord | undefined,
  lastEntryRunning: boolean,
  mtimeMs: number,
  archived: boolean,
  staleRunningMaxAgeMs = DEFAULT_STALE_RUNNING_MAX_AGE_MS,
): "running" | "idle" {
  if (archived || summary?.killed) return "idle";

  const latestActivityMs = Math.max(mtimeMs, summary?.lastModifiedMs ?? 0);
  const ageMs = Date.now() - latestActivityMs;

  if (summary && (summary.status || summary.notFullyIdle)) {
    if (summary.status === "CASCADE_RUN_STATUS_RUNNING" || summary.notFullyIdle) {
      return ageMs <= staleRunningMaxAgeMs ? "running" : "idle";
    }
    if (summary.status) {
      return "idle";
    }
  }

  return lastEntryRunning && ageMs <= STALE_RUNNING_MS ? "running" : "idle";
}

/**
 * 在全部非归档根会话中确定性地选出当前用户正在打开的会话：
 * 1. viewMs（last_user_view_time）更大者胜；
 * 2. viewMs 完全打平时（多标签/多工作区同批刷新常见），比较 lastUserInputMs（最近用户发消息）；
 * 3. 仍打平时保持 previousActiveId 粘性，彻底消除随机乒乓跳变；
 * 4. 再比较非归档运行态、annMtimeMs，最后按 sessionId 字典序兜底确保绝对确定性。
 */
export function selectActiveSessionId(
  candidates: RootCandidate[],
  previousActiveId: string | null = null,
): string | null {
  let best: RootCandidate | null = null;

  const isRunning = (c: RootCandidate): boolean => {
    if (c.archived || c.summary?.killed) return false;
    return (
      c.summary?.status === "CASCADE_RUN_STATUS_RUNNING" || Boolean(c.summary?.notFullyIdle)
    );
  };

  for (const c of candidates) {
    if (c.archived) continue;
    if (!best) {
      best = c;
      continue;
    }

    if (c.viewMs !== best.viewMs) {
      if (c.viewMs > best.viewMs) best = c;
      continue;
    }

    const cInput = c.summary?.lastUserInputMs ?? 0;
    const bInput = best.summary?.lastUserInputMs ?? 0;
    if (cInput !== bInput) {
      if (cInput > bInput) best = c;
      continue;
    }

    if (previousActiveId) {
      const cSticky = c.id === previousActiveId;
      const bSticky = best.id === previousActiveId;
      if (cSticky !== bSticky) {
        if (cSticky) best = c;
        continue;
      }
    }

    const cRun = isRunning(c);
    const bRun = isRunning(best);
    if (cRun !== bRun) {
      if (cRun) best = c;
      continue;
    }

    if (c.annMtimeMs !== best.annMtimeMs) {
      if (c.annMtimeMs > best.annMtimeMs) best = c;
      continue;
    }

    if (c.id < best.id) {
      best = c;
    }
  }

  return best ? best.id : null;
}

/**
 * 扫描本地 Antigravity 会话日志与结构化索引，返回所有根会话的上下文 Token 统计
 */
export class SessionScanner {
  private subagentIds = new Set<string>();
  private rootIds = new Set<string>();
  /** 记录上一次锁定的活跃会话 ID，在 viewMs 与 lastUserInputMs 同时打平时保持粘性 */
  private lastActiveSessionId: string | null = null;
  /** 仅在无 summary 记录时的兜底工作区匹配缓存，以 cand.id 为键原地覆盖避免旧 mtime 键泄漏 */
  private fallbackWorkspaceCache = new Map<string, { mtimeMs: number; matched: boolean }>();
  private lastWorkspaceKey = "";
  private transcriptCache = new Map<string, TranscriptCacheEntry>();
  /** 防止异常崩溃残留 RUNNING 状态永久卡住（默认 15 分钟无任何写入即降级为 idle） */
  private staleRunningMaxAgeMs = DEFAULT_STALE_RUNNING_MAX_AGE_MS;

  async scan(options: ScanOptions): Promise<ScanResult> {
    const brainDir = getBrainDir();
    const annDir = getAnnotationsDir();
    const convDir = getConversationsDir();

    // 1. 并发加载目录列表、项目注册表与权威会话索引（含 conversation_parents）
    const [brainNames, annNames, projects, indexSnapshot] = await Promise.all([
      readdirSafe(brainDir),
      readdirSafe(annDir),
      loadProjectRegistry(),
      loadConversationIndex(),
    ]);
    const summaries = indexSnapshot?.summaries ?? null;
    const pinnedFilter = (options.workspaceFilter || "").trim();
    const isPinnedWorkspace = Boolean(pinnedFilter && pinnedFilter !== "auto");

    const brainIds = brainNames.filter((n) => ID_RE.test(n));
    if (brainIds.length === 0) {
      const emptyWs = await resolveActiveWorkspace({
        activeSessionId: null,
        summaries,
        projects,
        hostPaths: options.workspacePaths,
        hostUris: options.workspaceUris,
        conversationsDir: convDir,
        pinnedWorkspaceKey: options.workspaceFilter,
      });
      return {
        sessions: [],
        activeSessionId: null,
        workspaceDetected: emptyWs.detected,
        workspaceLabel: emptyWs.label,
        activeWorkspaceKey: emptyWs.workspaceKey,
        isPinnedWorkspace,
        availableWorkspaces: [],
        totalVisibleCount: 0,
        scannedAtMs: Date.now(),
      };
    }

    // 2. 读取 annotations/*.pbtxt 获取最后查看时间、归档标记与 side_question_cascade_ids
    const annMeta = new Map<string, AnnotationMeta>();
    await Promise.all(
      annNames
        .filter((n) => n.endsWith(".pbtxt"))
        .map(async (n) => {
          const id = n.slice(0, -".pbtxt".length);
          if (!ID_RE.test(id)) return;
          const annPath = path.join(annDir, n);
          const st = await statSafe(annPath);
          if (st) {
            const meta = await parseAnnotationMeta(annPath, st.mtimeMs);
            annMeta.set(id, meta);
            for (const sqId of meta.sideQuestionIds) {
              this.subagentIds.add(sqId);
            }
          }
        }),
    );

    // 3. 收集全部子会话 ID：合并 conversation_parents（含 Side Question）、summaries 父子层级与 subagents 目录
    if (indexSnapshot?.childParentMap) {
      for (const childId of indexSnapshot.childParentMap.keys()) {
        this.subagentIds.add(childId);
      }
    }
    if (summaries) {
      for (const s of summaries.values()) {
        if (s.parentConversationId || s.nestingDepth > 0) {
          this.subagentIds.add(s.conversationId);
        }
      }
    }

    const rawCandidates: RootCandidate[] = [];
    await Promise.all(
      brainIds.map(async (id) => {
        const tp = transcriptPathFor(id);
        const st = await statSafe(tp);
        if (!st) return;

        // 兜底检查子代理登记目录
        const subFiles = await readdirSafe(path.join(brainDir, id, ".system_generated", "subagents"));
        for (const sf of subFiles) {
          if (sf.endsWith(".json")) this.subagentIds.add(sf.slice(0, -".json".length));
        }

        const meta = annMeta.get(id);
        const summary = summaries?.get(id);
        const viewMs = meta?.viewMs ?? 0;
        // 归档判定以 annotations/*.pbtxt 为最高权威，避免取消归档后被 FTS 滞后卡住
        const archived = meta !== undefined ? meta.archived : Boolean(summary?.archivedFromFts);
        const activityMs = Math.max(st.mtimeMs, summary?.lastModifiedMs ?? 0);

        rawCandidates.push({
          id,
          transcriptPath: tp,
          mtimeMs: st.mtimeMs,
          size: st.size,
          viewMs,
          annMtimeMs: meta?.annMtimeMs ?? 0,
          annTitle: meta?.title ?? null,
          archived,
          score: Math.max(viewMs, activityMs),
          summary,
        });
      }),
    );

    // 4. 过滤出所有根会话（去除 subagent 与 Side Question）并按最近活跃度排序
    const rootFlags = await Promise.all(
      rawCandidates.map((c) => this.isRoot(c.id, c.transcriptPath, c.summary)),
    );
    const rootCandidates = rawCandidates
      .filter((_, idx) => rootFlags[idx])
      .sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);

    // 5. 选出当前用户正在查看的非归档会话（平局按 lastUserInputMs 与粘性裁决），再锁定当前工作区
    const activeSessionId = selectActiveSessionId(rootCandidates, this.lastActiveSessionId);
    if (activeSessionId) {
      this.lastActiveSessionId = activeSessionId;
    }

    const activeWorkspace = await resolveActiveWorkspace({
      activeSessionId,
      summaries,
      projects,
      hostPaths: options.workspacePaths,
      hostUris: options.workspaceUris,
      conversationsDir: convDir,
      pinnedWorkspaceKey: options.workspaceFilter,
    });

    if (activeWorkspace.cacheKey !== this.lastWorkspaceKey) {
      this.fallbackWorkspaceCache.clear();
      this.lastWorkspaceKey = activeWorkspace.cacheKey;
    }

    // 6. 默认隐藏归档会话，聚合可切换工作区清单并计算工作区归属
    const includeArchived = Boolean(options.includeArchived);
    const visiblePool = includeArchived
      ? rootCandidates
      : rootCandidates.filter((c) => !c.archived);

    const availableWorkspaces = collectAvailableWorkspaces({
      summaries,
      projects,
      visibleCandidates: visiblePool.map((c) => ({
        projectId: c.summary?.projectId || "",
        workspaceName: resolveSessionWorkspaceName(c.summary, projects),
        normalizedUris: c.summary?.normalizedWorkspaceUris ?? [],
        outsideOfProject: isOutsideOfProjectSummary(c.summary),
      })),
    });

    const matchFlags = await Promise.all(
      visiblePool.map((c) => this.matchesActiveWorkspace(c, activeWorkspace, convDir)),
    );

    // 7. 分别保障当前工作区与全局会话的展示名额，防止主力工作区会话过多时截断掉其他工作区的历史会话
    const limit = options.limit ?? 30;
    const selectedIndices = new Set<number>();

    let wsAdded = 0;
    for (let i = 0; i < visiblePool.length && wsAdded < limit; i++) {
      if (matchFlags[i]) {
        selectedIndices.add(i);
        wsAdded++;
      }
    }

    let globalAdded = 0;
    for (let i = 0; i < visiblePool.length && globalAdded < limit; i++) {
      selectedIndices.add(i);
      globalAdded++;
    }

    if (activeSessionId) {
      const activeIdx = visiblePool.findIndex((c) => c.id === activeSessionId);
      if (activeIdx !== -1) selectedIndices.add(activeIdx);
    }

    const orderedIndices = [...selectedIndices].sort((a, b) => a - b);

    // 8. 增量解析选中会话的 Token 指标（命中 mtime+size 缓存的会话零 IO 开销）
    const sessions: SessionInfo[] = await Promise.all(
      orderedIndices.map(async (idx) => {
        const cand = visiblePool[idx];
        const matchesWorkspace = matchFlags[idx];
        const parsed = await parseTranscriptMetrics(
          cand.transcriptPath,
          cand.mtimeMs,
          cand.size,
          this.transcriptCache,
        );
        const cacheHitPercent =
          parsed.activeContextTokens > 0
            ? Math.round((parsed.cacheReadTokens / parsed.activeContextTokens) * 100)
            : 0;
        const rawTitle =
          cand.annTitle ||
          cand.summary?.title ||
          (cand.summary?.preview ? cleanUserTitle(cand.summary.preview) : "") ||
          parsed.title;
        const workspaceName =
          resolveSessionWorkspaceName(cand.summary, projects) ||
          (matchesWorkspace && activeWorkspace.detected ? activeWorkspace.label : "");
        const workspaceKey =
          resolveSessionWorkspaceKey(cand.summary, projects) ||
          (matchesWorkspace && activeWorkspace.detected ? activeWorkspace.workspaceKey : "");
        const lastUpdatedMs = Math.max(cand.mtimeMs, cand.summary?.lastModifiedMs ?? 0);

        return {
          sessionId: cand.id,
          shortId: cand.id.slice(0, 8),
          title: rawTitle || "Untitled session",
          activeContextTokens: parsed.activeContextTokens,
          freshInputTokens: parsed.freshInputTokens,
          cacheReadTokens: parsed.cacheReadTokens,
          cacheHitPercent,
          lastOutputTokens: parsed.lastOutputTokens,
          stepIndex: parsed.stepIndex,
          state: resolveSessionState(
            cand.summary,
            parsed.lastEntryRunning,
            cand.mtimeMs,
            cand.archived,
            this.staleRunningMaxAgeMs,
          ),
          lastUpdatedMs,
          lastViewedMs: cand.viewMs,
          matchesWorkspace,
          projectId: cand.summary?.projectId || "",
          workspaceName,
          workspaceKey,
          compacted: parsed.compacted,
          archived: cand.archived,
          transcriptPath: cand.transcriptPath,
          transcriptUri: toFileUri(cand.transcriptPath),
        };
      }),
    );

    return {
      sessions,
      activeSessionId,
      workspaceDetected: activeWorkspace.detected,
      workspaceLabel: activeWorkspace.label,
      activeWorkspaceKey: activeWorkspace.workspaceKey,
      isPinnedWorkspace,
      availableWorkspaces,
      totalVisibleCount: visiblePool.length,
      scannedAtMs: Date.now(),
    };
  }

  /**
   * 判断会话是否为顶层根会话（非 subagent 子代理、非 Side Question 侧边提问）。
   * 修复首行 >4KB 被截断时反复读盘问题：只要首行前缀明确包含 USER_INPUT 或 USER_EXPLICIT 即稳定缓存至 rootIds。
   */
  private async isRoot(
    id: string,
    transcriptPath: string,
    summary: SummaryRecord | undefined,
  ): Promise<boolean> {
    if (summary && (summary.parentConversationId || summary.nestingDepth > 0)) {
      this.subagentIds.add(id);
      return false;
    }
    if (this.subagentIds.has(id)) return false;
    if (this.rootIds.has(id)) return true;

    const head = await readHead(transcriptPath, 4096);
    if (!head) return false;
    const firstLine = head.split(/\r?\n/)[0] || "";
    if (firstLine.includes('"source":"SYSTEM"') && firstLine.includes("sender=")) {
      this.subagentIds.add(id);
      return false;
    }
    if (
      firstLine.endsWith("}") ||
      firstLine.includes('"type":"USER_INPUT"') ||
      firstLine.includes('"source":"USER_EXPLICIT"')
    ) {
      this.rootIds.add(id);
    }
    return true;
  }

  /**
   * 判断会话是否属于当前锁定的活动工作区：
   * 优先使用 conversation_summaries.db 的权威 project_id / workspace_uris 做 O(1) 内存比对；
   * 仅当某条新建会话尚未落盘到 summary 表时，降级到按 cand.id 原地覆盖缓存的安全文件嗅探。
   */
  private async matchesActiveWorkspace(
    cand: RootCandidate,
    activeWorkspace: ActiveWorkspace,
    convDir: string,
  ): Promise<boolean> {
    if (!activeWorkspace.detected) return true;

    if (cand.summary) {
      if (activeWorkspace.outsideOfProject) {
        return isOutsideOfProjectSummary(cand.summary);
      }
      if (activeWorkspace.projectId && cand.summary.projectId === activeWorkspace.projectId) {
        return true;
      }
      return cand.summary.normalizedWorkspaceUris.some((u) =>
        activeWorkspace.normalizedUris.has(u),
      );
    }

    // 兜底路径：仅对不在 summary 表中的极端场景生效
    if (activeWorkspace.outsideOfProject) return false;

    const dbPath = path.join(convDir, `${cand.id}.db`);
    const dbStat = await statSafe(dbPath);
    const effectiveMtime = dbStat?.mtimeMs ?? cand.mtimeMs;
    const cached = this.fallbackWorkspaceCache.get(cand.id);
    if (cached && cached.mtimeMs === effectiveMtime) {
      return cached.matched;
    }

    const normPaths = [...activeWorkspace.normalizedUris];
    const uriNeedles = buildEncodedUriNeedles(normPaths);
    const ok = dbStat
      ? await fileContainsAnyFallback(dbPath, uriNeedles, true)
      : await fileContainsAnyFallback(cand.transcriptPath, normPaths, false);

    // 按 cand.id 原地覆盖缓存，彻底消除旧 mtime 键堆积造成的内存泄漏
    this.fallbackWorkspaceCache.set(cand.id, { mtimeMs: effectiveMtime, matched: ok });
    return ok;
  }
}

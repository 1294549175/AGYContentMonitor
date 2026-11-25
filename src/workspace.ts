import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 来自 conversation_summaries.db 的单条权威会话索引 */
export interface SummaryRecord {
  conversationId: string;
  title: string;
  preview: string;
  stepCount: number;
  lastModifiedMs: number;
  /** 用户最近一次发送消息的时间（毫秒），用于多会话查看时间打平时的确定性裁决 */
  lastUserInputMs: number;
  workspaceUris: string[];
  normalizedWorkspaceUris: string[];
  status: string;
  projectId: string;
  parentConversationId: string;
  nestingDepth: number;
  notFullyIdle: boolean;
  killed: boolean;
  archivedFromFts: boolean;
  projectFromFts: string;
}

/** 单次读取 conversation_summaries.db 得到的完整索引快照 */
export interface ConversationIndexSnapshot {
  summaries: Map<string, SummaryRecord>;
  /** 来自 conversation_parents 表的子会话 -> 父会话映射（含 Side Question） */
  childParentMap: Map<string, string>;
  loadedAtMs: number;
}

/** 来自 ~/.gemini/config/projects/*.json 的项目元数据 */
export interface ProjectRecord {
  id: string;
  name: string;
  normalizedUris: string[];
}

/** 供前端下拉选择器展示的可切换工作区选项 */
export interface WorkspaceOption {
  key: string;
  label: string;
  projectId: string | null;
  normalizedUris: string[];
  outsideOfProject: boolean;
  sessionCount: number;
}

/** 当前锁定的活动工作区描述 */
export interface ActiveWorkspace {
  detected: boolean;
  projectId: string | null;
  normalizedUris: Set<string>;
  label: string;
  outsideOfProject: boolean;
  cacheKey: string;
  /** 与 WorkspaceOption.key 对齐的稳定工作区键 */
  workspaceKey: string;
}

interface SqliteStatementLike {
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

interface SqliteModuleLike {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => SqliteDatabaseLike;
}

export const OUTSIDE_PROJECT_ID = "outside-of-project";
const OUTSIDE_PROJECT_LABEL = "独立对话";
const DB_SNIFF_HEAD_BYTES = 1024 * 1024;
const DB_SCAN_LIMIT = 64 * 1024 * 1024;
const TRANSCRIPT_SNIFF_BYTES = 64 * 1024;
/** SQLite 偶发 SQLITE_BUSY 时允许复用的陈旧快照最长有效期 */
const INDEX_STALE_FALLBACK_TTL_MS = 60_000;
/** projects/*.json 目录短周期缓存有效期 */
const PROJECT_REGISTRY_CACHE_TTL_MS = 15_000;
/** conversations_fts 低频元数据缓存有效期（避免每 3 秒全表扫描 FTS5） */
const FTS_FALLBACK_CACHE_TTL_MS = 60_000;

let sqliteModulePromise: Promise<SqliteModuleLike | null> | null = null;
let lastGoodIndexSnapshot: ConversationIndexSnapshot | null = null;
let projectRegistryCache: {
  dirMtimeMs: number;
  loadedAtMs: number;
  data: Map<string, ProjectRecord>;
} | null = null;
let ftsFallbackCache: {
  loadedAtMs: number;
  data: Map<string, { archived: boolean; project: string }>;
} | null = null;

export function getGeminiRoot(): string {
  return path.join(os.homedir(), ".gemini");
}

export function getAgyRoot(): string {
  return path.join(getGeminiRoot(), "antigravity");
}

export function getProjectsDir(): string {
  return path.join(getGeminiRoot(), "config", "projects");
}

export function getSummaryDbPath(): string {
  return path.join(getAgyRoot(), "conversation_summaries.db");
}

/**
 * 懒加载 Node 内置的 node:sqlite 模块；若运行环境低于 Node 22.5 则返回 null 触发安全降级
 */
async function loadSqliteModule(): Promise<SqliteModuleLike | null> {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import("node:sqlite")
      .then((mod) => mod as unknown as SqliteModuleLike)
      .catch(() => null);
  }
  return sqliteModulePromise;
}

/**
 * 将 file:// URI 解析为本地路径（支持大小写 FILE://、无尾斜杠盘符 %3A 与 UNC 主机路径）；
 * 仅对匹配 file:// 协议的输入执行 URL 解码，避免误改普通本地路径中含字面 %20 的目录名。
 */
function decodeFileUriToPath(uri: string): string {
  const loweredScheme = uri.replace(/^file:\/\//i, "file://");
  const fixedDrive = loweredScheme.replace(/^file:\/\/\/([a-zA-Z])%3[aA](?=\/|$)/, "file:///$1:/");
  try {
    return fileURLToPath(fixedDrive);
  } catch {
    const isUncUri = /^file:\/\/[^/]/i.test(fixedDrive);
    let fallback = isUncUri
      ? fixedDrive.replace(/^file:\/\//i, "//")
      : fixedDrive.replace(/^file:\/\/\//i, "");
    try {
      fallback = decodeURIComponent(fallback);
    } catch {
      // 保留原始片段，避免非法百分号序列抛异常
    }
    return fallback;
  }
}

/**
 * 将任意 file:// URI 或本地文件系统路径统一规范为可稳定比对的标准路径键：
 * 1. 仅对 file:// URI 执行盘符 %3A 修复与 URL 解码，保留普通本地路径字面 % 字符；
 * 2. 保留 Windows UNC 前缀 //server/share 不被折叠为单斜杠，统一反斜杠为正斜杠并去普通目录尾斜杠；
 * 3. Windows 盘符与 UNC 路径统一转小写，消除大小写与编码差异导致的误判。
 */
export function normalizeFileUri(uriOrPath: string): string {
  const trimmed = uriOrPath.trim();
  if (!trimmed) return "";

  const rawPath = /^file:\/\//i.test(trimmed) ? decodeFileUriToPath(trimmed) : trimmed;
  const isUnc = /^(\\\\|\/\/)[^\\/]/.test(rawPath);

  let normalized = rawPath.replace(/\\+/g, "/").replace(/\/+/g, "/");
  if (isUnc && !normalized.startsWith("//")) {
    normalized = `/${normalized}`;
  }

  // 保留根目录斜杠（如 c:/ 或 /），去除普通目录末尾斜杠
  if (normalized.length > 1 && !/^[a-zA-Z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, "");
  }
  if (/^[a-zA-Z]:(\/|$)/.test(normalized) || isUnc || process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * 从规范化路径或原始 URI 中提取适合展示的目录短名（如 Sid Meier's Civilization 5）
 */
export function basenameOfPath(uriOrPath: string): string {
  const trimmed = uriOrPath.trim();
  if (!trimmed) return "";

  const display = /^file:\/\//i.test(trimmed) ? decodeFileUriToPath(trimmed) : trimmed;
  const slashPath = display.replace(/\\+/g, "/").replace(/\/+$/, "");
  return path.posix.basename(slashPath) || slashPath;
}

/**
 * 读取 ~/.gemini/config/projects/*.json，建立 projectId -> 项目名及文件夹 URI 映射。
 * 引入目录 mtimeMs 与短周期（15s）内存缓存，减少 3 秒轮询期间的重复磁盘读取。
 */
export async function loadProjectRegistry(): Promise<Map<string, ProjectRecord>> {
  const dir = getProjectsDir();
  const now = Date.now();

  let dirMtimeMs = 0;
  try {
    const st = await fs.promises.stat(dir);
    dirMtimeMs = st.mtimeMs;
  } catch {
    return new Map<string, ProjectRecord>();
  }

  if (
    projectRegistryCache &&
    projectRegistryCache.dirMtimeMs === dirMtimeMs &&
    now - projectRegistryCache.loadedAtMs < PROJECT_REGISTRY_CACHE_TTL_MS
  ) {
    return projectRegistryCache.data;
  }

  const result = new Map<string, ProjectRecord>();
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return result;
  }

  await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (name) => {
        try {
          const text = await fs.promises.readFile(path.join(dir, name), "utf8");
          const raw = JSON.parse(text) as {
            id?: string;
            name?: string;
            projectResources?: {
              resources?: Array<{
                folderUri?: string;
                workspaceUri?: string;
                gitFolder?: { folderUri?: string };
              }>;
            };
          };
          if (!raw.id) return;

          const uris = new Set<string>();
          for (const res of raw.projectResources?.resources ?? []) {
            const candidate = res.folderUri || res.gitFolder?.folderUri || res.workspaceUri;
            if (candidate) {
              const norm = normalizeFileUri(candidate);
              if (norm) uris.add(norm);
            }
          }
          result.set(raw.id, {
            id: raw.id,
            name: (raw.name || "").trim() || basenameOfPath([...uris][0] || "") || raw.id,
            normalizedUris: [...uris],
          });
        } catch {
          // 忽略损坏的项目配置文件
        }
      }),
  );

  projectRegistryCache = {
    dirMtimeMs,
    loadedAtMs: now,
    data: result,
  };
  return result;
}

/**
 * 解析 conversation_summaries.db 中的 workspace_uris JSON 数组字段
 */
function parseWorkspaceUrisField(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
      }
    } catch {
      return [];
    }
  }
  return [trimmed];
}

/**
 * 安全解析 SQLite 中的 ISO / RFC3339 时间戳为毫秒
 */
function parseDbTimestampMs(raw: unknown): number {
  if (typeof raw !== "string" || !raw.trim()) return 0;
  // 兼容形如 "2026-11-23 10:42:55.9998002+00:00"（截断纳秒到毫秒并替换空格为 T）
  const iso = raw.trim().replace(" ", "T").replace(/\.(\d{3})\d+/, ".$1");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * 低频加载 conversations_fts 中的 archived 与 project 兜底元数据（最多 60 秒扫描一次）。
 * 原因：conversations_fts 是 FTS5 虚拟表，每 3 秒执行一次 WHERE chunk_index = -1 会造成高频全表扫描；
 * 常规场景已由 annotations/*.pbtxt 与 projects/*.json 覆盖，此处仅保留低频安全兜底。
 */
function loadFtsFallbackMeta(
  db: SqliteDatabaseLike,
  now: number,
): Map<string, { archived: boolean; project: string }> {
  if (ftsFallbackCache && now - ftsFallbackCache.loadedAtMs < FTS_FALLBACK_CACHE_TTL_MS) {
    return ftsFallbackCache.data;
  }

  const ftsMeta = new Map<string, { archived: boolean; project: string }>();
  try {
    const ftsRows = db
      .prepare(
        `SELECT conversation_id, archived, project
         FROM conversations_fts
         WHERE chunk_index = -1`,
      )
      .all();
    for (const r of ftsRows) {
      const cid = String(r.conversation_id || "");
      if (!cid) continue;
      ftsMeta.set(cid, {
        archived: Number(r.archived) === 1,
        project: String(r.project || "").trim(),
      });
    }
    ftsFallbackCache = { loadedAtMs: now, data: ftsMeta };
    return ftsMeta;
  } catch {
    // FTS 表不存在或 schema 变更时静默降级，优先复用既有缓存或返回空 Map
    return ftsFallbackCache?.data ?? ftsMeta;
  }
}

/**
 * 以只读方式从 ~/.gemini/antigravity/conversation_summaries.db 加载全量权威会话索引快照。
 * 单次只读打开同时提取：
 * 1. conversation_summaries（含 last_user_input_time，用于多会话查看时间打平时的确定性裁决）；
 * 2. conversation_parents（捕获 Side Question 等侧边提问子会话，防止泄漏进根会话列表）；
 * 3. 低频缓存的 FTS 兜底元数据，彻底消除每 3 秒一次的 FTS5 全表扫描；
 * 4. 捕获 SQLITE_BUSY 等瞬时读取失败时，60 秒内回退返回最近一次成功快照，避免降级为全盘扫描 .db。
 */
export async function loadConversationIndex(): Promise<ConversationIndexSnapshot | null> {
  const dbPath = getSummaryDbPath();
  if (!fs.existsSync(dbPath)) return null;

  const sqliteMod = await loadSqliteModule();
  if (!sqliteMod) return null;

  const now = Date.now();
  let db: SqliteDatabaseLike | null = null;
  try {
    db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 500;");
    } catch {
      // 某些只读场景下忽略 busy_timeout 失败
    }

    let rows: Array<Record<string, unknown>>;
    try {
      rows = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time,
                  last_user_input_time, workspace_uris, status, project_id,
                  parent_conversation_id, nesting_depth, not_fully_idle, killed
           FROM conversation_summaries`,
        )
        .all();
    } catch {
      // 兼容旧版本数据库尚未包含 last_user_input_time 列的情况
      rows = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time,
                  workspace_uris, status, project_id, parent_conversation_id,
                  nesting_depth, not_fully_idle, killed
           FROM conversation_summaries`,
        )
        .all();
    }

    // 读取 conversation_parents 映射（含 Side Question 等侧边子会话）
    const childParentMap = new Map<string, string>();
    try {
      const parentRows = db
        .prepare(`SELECT conversation_id, parent_id FROM conversation_parents`)
        .all();
      for (const r of parentRows) {
        const childId = String(r.conversation_id || "").trim();
        const parentId = String(r.parent_id || "").trim();
        if (childId && parentId) {
          childParentMap.set(childId, parentId);
        }
      }
    } catch {
      // 旧版本数据库不存在 conversation_parents 表时静默降级为空 Map
    }

    const ftsMeta = loadFtsFallbackMeta(db, now);
    const map = new Map<string, SummaryRecord>();
    for (const r of rows) {
      const id = String(r.conversation_id || "");
      if (!id) continue;
      const uris = parseWorkspaceUrisField(r.workspace_uris);
      const normalizedUris = [...new Set(uris.map(normalizeFileUri).filter(Boolean))];
      const fts = ftsMeta.get(id);

      map.set(id, {
        conversationId: id,
        title: String(r.title || "").trim(),
        preview: String(r.preview || "").trim(),
        stepCount: Number(r.step_count) || 0,
        lastModifiedMs: parseDbTimestampMs(r.last_modified_time),
        lastUserInputMs: parseDbTimestampMs(r.last_user_input_time),
        workspaceUris: uris,
        normalizedWorkspaceUris: normalizedUris,
        status: String(r.status || "").trim(),
        projectId: String(r.project_id || "").trim(),
        parentConversationId: String(r.parent_conversation_id || "").trim(),
        nestingDepth: Number(r.nesting_depth) || 0,
        notFullyIdle: Boolean(r.not_fully_idle),
        killed: Boolean(r.killed),
        archivedFromFts: fts?.archived ?? false,
        projectFromFts: fts?.project ?? "",
      });
    }

    const snapshot: ConversationIndexSnapshot = {
      summaries: map,
      childParentMap,
      loadedAtMs: now,
    };
    lastGoodIndexSnapshot = snapshot;
    return snapshot;
  } catch (err) {
    if (
      lastGoodIndexSnapshot &&
      now - lastGoodIndexSnapshot.loadedAtMs <= INDEX_STALE_FALLBACK_TTL_MS
    ) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[context-monitor] conversation_summaries.db 瞬时读取失败，已回退陈旧快照: ${msg}\n`,
      );
      return lastGoodIndexSnapshot;
    }
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // 忽略关闭异常
    }
  }
}

/**
 * 兼容旧版导出：仅返回 conversation_summaries 映射（内部复用 loadConversationIndex）
 */
export async function loadConversationSummaries(): Promise<Map<string, SummaryRecord> | null> {
  const snapshot = await loadConversationIndex();
  return snapshot ? snapshot.summaries : null;
}

/**
 * 兜底逻辑：仅当 conversation_summaries.db 不可用时，从单会话 .db 头部提取工作区 URI。
 * 优先匹配已知项目注册表中的完整 URI，其次用支持百分号编码与空格的正则提取并解码。
 */
export async function inferWorkspaceFromDbFallback(
  dbPath: string,
  projects: Map<string, ProjectRecord>,
): Promise<{ projectId: string | null; normalizedUri: string; label: string } | null> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(dbPath, "r");
    const buf = Buffer.alloc(DB_SNIFF_HEAD_BYTES);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    if (bytesRead <= 0) return null;

    const text = buf.toString("latin1", 0, bytesRead);
    const lowerText = text.toLowerCase();

    // 1. 优先用已知项目的规范化路径做精确命中，避免 protobuf 相邻字节截断或粘连
    for (const proj of projects.values()) {
      for (const norm of proj.normalizedUris) {
        const needles = buildEncodedUriNeedles([norm]);
        if (needles.some((n) => containsUriBoundary(lowerText, n))) {
          return { projectId: proj.id, normalizedUri: norm, label: proj.name };
        }
      }
    }

    // 2. 退回到支持 % 编码与空格的 URI 正则
    const re = /file:\/\/\/([a-zA-Z])(?::|%3[aA])\/([a-zA-Z0-9_.\-/% ()'+]+)/g;
    const candidates: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const rawUri = `file:///${m[1]}:/${m[2]}`;
      let norm = normalizeFileUri(rawUri);
      if (!norm || norm.includes("/.gemini/")) continue;
      if (/\.[a-zA-Z0-9]{1,10}$/.test(norm)) {
        norm = path.posix.dirname(norm);
      }
      if (norm.length > 3) {
        candidates.push(norm);
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.length - b.length);
    return {
      projectId: null,
      normalizedUri: candidates[0],
      label: basenameOfPath(candidates[0]),
    };
  } catch {
    return null;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

/**
 * 为兜底二进制/文本搜索构造多种 URI 编码形式（小写盘符、%3a、空格编码 %20、撇号 %27 等）
 */
export function buildEncodedUriNeedles(normalizedPaths: string[]): string[] {
  const result = new Set<string>();
  for (const norm of normalizedPaths) {
    if (!norm) continue;
    const m = /^([a-z]):\/(.*)$/.exec(norm);
    if (m) {
      const restRaw = m[2];
      const restEncoded = restRaw
        .split("/")
        .map((seg) => encodeURIComponent(seg).replace(/'/g, "%27").toLowerCase())
        .join("/");
      result.add(`file:///${m[1]}:/${restRaw}`);
      result.add(`file:///${m[1]}%3a/${restRaw}`);
      result.add(`file:///${m[1]}:/${restEncoded}`);
      result.add(`file:///${m[1]}%3a/${restEncoded}`);
    } else if (norm.startsWith("/")) {
      const encoded = norm
        .split("/")
        .map((seg) => encodeURIComponent(seg).replace(/'/g, "%27").toLowerCase())
        .join("/");
      result.add(`file://${norm}`);
      result.add(`file://${encoded}`);
    }
  }
  return [...result];
}

/**
 * 校验路径命中后的边界字符，防止同前缀目录名误匹配（如 np 误匹配 np 2 或 np中文）。
 * 文本模式（isTranscriptText = true）允许紧邻 `/` 以命中工作区子文件路径；
 * 二进制 .db 模式（isTranscriptText = false）拒绝 `/` 以避免父目录误吞子目录工作区。
 */
export function containsUriBoundary(
  hay: string,
  needle: string,
  isTranscriptText = false,
): boolean {
  if (!needle) return false;
  const bad = isTranscriptText ? /[a-z0-9_.\-%]/i : /[a-z0-9_.\-/%]/i;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    const endIdx = idx + needle.length;
    const next = hay.charAt(endIdx);
    if (!next) return true;
    const isNonAscii = next.charCodeAt(0) > 0x7f;
    const isSpaceFollowedByPathPart =
      next === " " && /[a-z0-9_.\-()\u0080-\uffff]/i.test(hay.charAt(endIdx + 1));
    if (!bad.test(next) && !isNonAscii && !isSpaceFollowedByPathPart) {
      return true;
    }
    idx = hay.indexOf(needle, idx + 1);
  }
  return false;
}

/**
 * 兜底内容嗅探：仅在会话尚未进入 conversation_summaries.db 时使用。
 * 读取 transcript.jsonl 文本时使用 utf8 解码，确保中文及非 ASCII 工作区目录可正常匹配；
 * 读取 .db 二进制时保留 latin1 扫描编码后的 URI 片段。
 */
export async function fileContainsAnyFallback(
  filePath: string,
  needles: string[],
  isDbBinary: boolean,
): Promise<boolean> {
  const normalizedNeedles = needles.map((n) => n.toLowerCase()).filter(Boolean);
  if (normalizedNeedles.length === 0) return false;

  const limit = isDbBinary ? DB_SCAN_LIMIT : TRANSCRIPT_SNIFF_BYTES;
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, "r");
    const chunkSize = 512 * 1024;
    const overlap = 1024;
    const buf = Buffer.alloc(chunkSize);
    let pos = 0;
    let carry = "";
    while (pos < limit) {
      const { bytesRead } = await fd.read(buf, 0, Math.min(chunkSize, limit - pos), pos);
      if (bytesRead <= 0) break;
      const decoded = buf.toString(isDbBinary ? "latin1" : "utf8", 0, bytesRead);
      const raw = carry + decoded;
      const hay = isDbBinary
        ? raw.toLowerCase()
        : raw.toLowerCase().replace(/%3a/g, ":").replace(/\\+/g, "/");
      for (const n of normalizedNeedles) {
        if (containsUriBoundary(hay, n, !isDbBinary)) return true;
      }
      carry = hay.slice(-overlap);
      pos += bytesRead;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

/**
 * 判定“独立无工作区对话”（outside-of-project）
 */
export function isOutsideOfProjectSummary(summary: SummaryRecord | undefined): boolean {
  if (!summary) return false;
  return (
    summary.projectId === OUTSIDE_PROJECT_ID ||
    (!summary.projectId && summary.normalizedWorkspaceUris.length === 0)
  );
}

/**
 * 解析单条会话的可读工作区显示名（供「全部会话」卡片标注所属项目）
 */
export function resolveSessionWorkspaceName(
  summary: SummaryRecord | undefined,
  projects: Map<string, ProjectRecord>,
): string {
  if (!summary) return "";
  if (isOutsideOfProjectSummary(summary)) return OUTSIDE_PROJECT_LABEL;
  if (summary.projectId && projects.has(summary.projectId)) {
    return projects.get(summary.projectId)!.name;
  }
  if (summary.projectFromFts) return summary.projectFromFts;
  if (summary.workspaceUris[0]) return basenameOfPath(summary.workspaceUris[0]);
  return "";
}

/**
 * 根据项目 ID、规范化 URI 与独立对话标志计算统一稳定的工作区键，
 * 供前端工作区下拉框（WorkspaceOption.key）、会话卡片与 resolveActiveWorkspace 共用。
 */
export function computeWorkspaceKey(params: {
  projectId?: string | null;
  normalizedUris?: Iterable<string>;
  outsideOfProject?: boolean;
  projects: Map<string, ProjectRecord>;
}): string {
  const { projectId, normalizedUris, outsideOfProject, projects } = params;
  if (outsideOfProject || projectId === OUTSIDE_PROJECT_ID) {
    return OUTSIDE_PROJECT_ID;
  }
  if (projectId) {
    return `project:${projectId}`;
  }
  const uris = [...new Set(normalizedUris ?? [])].filter(Boolean).sort();
  if (uris.length > 0) {
    for (const proj of projects.values()) {
      if (proj.normalizedUris.some((u) => uris.includes(u))) {
        return `project:${proj.id}`;
      }
    }
    return `uri:${uris[0]}`;
  }
  return "";
}

/**
 * 从单条 SummaryRecord 推导其稳定工作区键
 */
export function resolveSessionWorkspaceKey(
  summary: SummaryRecord | undefined,
  projects: Map<string, ProjectRecord>,
): string {
  if (!summary) return "";
  return computeWorkspaceKey({
    projectId: summary.projectId || null,
    normalizedUris: summary.normalizedWorkspaceUris,
    outsideOfProject: isOutsideOfProjectSummary(summary),
    projects,
  });
}

/**
 * 聚合当前可见根会话涉及的全部可切换工作区清单（含会话计数），供前端下拉框渲染。
 * 排序规则：普通工作区按会话数降序、名称字母序排列，“独立对话”固定置于末尾。
 */
export function collectAvailableWorkspaces(params: {
  summaries: Map<string, SummaryRecord> | null;
  projects: Map<string, ProjectRecord>;
  visibleCandidates: Array<{
    projectId: string;
    workspaceName: string;
    normalizedUris: string[];
    outsideOfProject: boolean;
  }>;
}): WorkspaceOption[] {
  const { summaries, projects, visibleCandidates } = params;
  const buckets = new Map<
    string,
    {
      key: string;
      label: string;
      projectId: string | null;
      uriSet: Set<string>;
      outsideOfProject: boolean;
      sessionCount: number;
    }
  >();

  // 预建 projectId -> 已知 URI 补充集合，确保项目元数据与摘要 URI 并集完整
  const summaryUrisByProject = new Map<string, Set<string>>();
  if (summaries) {
    for (const s of summaries.values()) {
      if (!s.projectId || s.projectId === OUTSIDE_PROJECT_ID) continue;
      let set = summaryUrisByProject.get(s.projectId);
      if (!set) {
        set = new Set<string>();
        summaryUrisByProject.set(s.projectId, set);
      }
      for (const u of s.normalizedWorkspaceUris) set.add(u);
    }
  }

  for (const cand of visibleCandidates) {
    const key = computeWorkspaceKey({
      projectId: cand.projectId || null,
      normalizedUris: cand.normalizedUris,
      outsideOfProject: cand.outsideOfProject,
      projects,
    });
    if (!key) continue;

    let bucket = buckets.get(key);
    if (!bucket) {
      const isOutside = key === OUTSIDE_PROJECT_ID;
      const resolvedProjectId = key.startsWith("project:")
        ? key.slice("project:".length)
        : isOutside
          ? OUTSIDE_PROJECT_ID
          : null;
      const proj = resolvedProjectId ? projects.get(resolvedProjectId) : undefined;
      const uriSet = new Set<string>(proj?.normalizedUris ?? []);
      if (resolvedProjectId) {
        for (const u of summaryUrisByProject.get(resolvedProjectId) ?? []) {
          uriSet.add(u);
        }
      }
      for (const u of cand.normalizedUris) {
        if (u) uriSet.add(u);
      }

      const label = isOutside
        ? OUTSIDE_PROJECT_LABEL
        : proj?.name ||
          cand.workspaceName ||
          basenameOfPath([...uriSet][0] || "") ||
          resolvedProjectId ||
          "Workspace";

      bucket = {
        key,
        label,
        projectId: resolvedProjectId,
        uriSet,
        outsideOfProject: isOutside,
        sessionCount: 0,
      };
      buckets.set(key, bucket);
    } else {
      for (const u of cand.normalizedUris) {
        if (u) bucket.uriSet.add(u);
      }
      if (!bucket.label && cand.workspaceName) {
        bucket.label = cand.workspaceName;
      }
    }

    bucket.sessionCount += 1;
  }

  return [...buckets.values()]
    .map((b) => ({
      key: b.key,
      label: b.label,
      projectId: b.projectId,
      normalizedUris: [...b.uriSet].sort(),
      outsideOfProject: b.outsideOfProject,
      sessionCount: b.sessionCount,
    }))
    .sort((a, b) => {
      if (a.outsideOfProject !== b.outsideOfProject) {
        return a.outsideOfProject ? 1 : -1;
      }
      return b.sessionCount - a.sessionCount || a.label.localeCompare(b.label);
    });
}

/**
 * 解析前端手动锁定的工作区键（pinnedWorkspaceKey）；无法解析时返回 null 以便回退自动推断。
 */
function resolvePinnedWorkspace(
  pinnedKey: string,
  summaries: Map<string, SummaryRecord> | null,
  projects: Map<string, ProjectRecord>,
): ActiveWorkspace | null {
  if (pinnedKey === "__all__") {
    return {
      detected: false,
      projectId: null,
      normalizedUris: new Set(),
      label: "All Workspaces",
      outsideOfProject: false,
      cacheKey: "pinned:all",
      workspaceKey: "__all__",
    };
  }

  if (pinnedKey === OUTSIDE_PROJECT_ID) {
    return {
      detected: true,
      projectId: OUTSIDE_PROJECT_ID,
      normalizedUris: new Set(),
      label: OUTSIDE_PROJECT_LABEL,
      outsideOfProject: true,
      cacheKey: `pinned:${OUTSIDE_PROJECT_ID}`,
      workspaceKey: OUTSIDE_PROJECT_ID,
    };
  }

  const projectId = pinnedKey.startsWith("project:")
    ? pinnedKey.slice("project:".length)
    : projects.has(pinnedKey)
      ? pinnedKey
      : null;

  if (projectId) {
    const proj = projects.get(projectId);
    const normalizedUris = new Set<string>(proj?.normalizedUris ?? []);
    let fallbackLabel = "";

    if (summaries) {
      for (const s of summaries.values()) {
        if (s.projectId !== projectId) continue;
        for (const u of s.normalizedWorkspaceUris) normalizedUris.add(u);
        if (!fallbackLabel) {
          fallbackLabel = s.projectFromFts || basenameOfPath(s.workspaceUris[0] || "");
        }
      }
    }

    if (proj || normalizedUris.size > 0 || fallbackLabel) {
      const label = proj?.name || fallbackLabel || projectId;
      const workspaceKey = `project:${projectId}`;
      return {
        detected: true,
        projectId,
        normalizedUris,
        label,
        outsideOfProject: false,
        cacheKey: `pinned:${workspaceKey}:${[...normalizedUris].sort().join("|")}`,
        workspaceKey,
      };
    }
    return null;
  }

  if (pinnedKey.startsWith("uri:")) {
    const uri = normalizeFileUri(pinnedKey.slice("uri:".length));
    if (!uri) return null;
    for (const proj of projects.values()) {
      if (proj.normalizedUris.includes(uri)) {
        const uris = new Set<string>(proj.normalizedUris);
        const workspaceKey = `project:${proj.id}`;
        return {
          detected: true,
          projectId: proj.id,
          normalizedUris: uris,
          label: proj.name,
          outsideOfProject: false,
          cacheKey: `pinned:${workspaceKey}:${[...uris].sort().join("|")}`,
          workspaceKey,
        };
      }
    }
    const workspaceKey = `uri:${uri}`;
    return {
      detected: true,
      projectId: null,
      normalizedUris: new Set([uri]),
      label: basenameOfPath(uri) || uri,
      outsideOfProject: false,
      cacheKey: `pinned:${workspaceKey}`,
      workspaceKey,
    };
  }

  return null;
}

/**
 * 根据手动锁定工作区（pinnedWorkspaceKey）、宿主显式提供的 roots 或当前活跃会话（activeSessionId）锁定活动工作区。
 * 优先级：手动指定工作区 > 宿主显式 MCP Roots > 当前用户正在查看的 activeSessionId > 单会话 .db 安全嗅探。
 */
export async function resolveActiveWorkspace(params: {
  activeSessionId: string | null;
  summaries: Map<string, SummaryRecord> | null;
  projects: Map<string, ProjectRecord>;
  hostPaths: string[];
  hostUris: string[];
  conversationsDir: string;
  pinnedWorkspaceKey?: string | null;
}): Promise<ActiveWorkspace> {
  const {
    activeSessionId,
    summaries,
    projects,
    hostPaths,
    hostUris,
    conversationsDir,
    pinnedWorkspaceKey,
  } = params;

  // 0. 前端显式手动锁定工作区（非空且非 auto）时优先采用
  const trimmedPinned = (pinnedWorkspaceKey || "").trim();
  if (trimmedPinned && trimmedPinned !== "auto") {
    const pinned = resolvePinnedWorkspace(trimmedPinned, summaries, projects);
    if (pinned) return pinned;
  }

  // 1. 宿主（如 VS Code / Antigravity IDE）明确下发了 MCP Roots 时优先采用
  const hostNormalized = new Set<string>();
  const hostRawForLabel: string[] = [];
  for (const p of [...hostPaths, ...hostUris]) {
    const norm = normalizeFileUri(p);
    if (norm) {
      hostNormalized.add(norm);
      hostRawForLabel.push(p);
    }
  }
  if (hostNormalized.size > 0) {
    let matchedProjectId: string | null = null;
    let label = "";
    for (const proj of projects.values()) {
      if (proj.normalizedUris.some((u) => hostNormalized.has(u))) {
        matchedProjectId = proj.id;
        label = proj.name;
        for (const u of proj.normalizedUris) hostNormalized.add(u);
        break;
      }
    }
    if (!label) {
      const uniqueNames = [...new Set(hostRawForLabel.map(basenameOfPath).filter(Boolean))];
      label = uniqueNames.join(", ") || "Workspace";
    }
    const workspaceKey = computeWorkspaceKey({
      projectId: matchedProjectId,
      normalizedUris: hostNormalized,
      outsideOfProject: false,
      projects,
    });
    const cacheKey = `host:${matchedProjectId || ""}:${[...hostNormalized].sort().join("|")}`;
    return {
      detected: true,
      projectId: matchedProjectId,
      normalizedUris: hostNormalized,
      label,
      outsideOfProject: false,
      cacheKey,
      workspaceKey,
    };
  }

  // 2. 无宿主 Roots（Antigravity App 全局 MCP 服务）时，跟随当前正在查看的 activeSessionId
  if (activeSessionId) {
    const activeSummary = summaries?.get(activeSessionId);
    if (activeSummary) {
      if (isOutsideOfProjectSummary(activeSummary)) {
        return {
          detected: true,
          projectId: OUTSIDE_PROJECT_ID,
          normalizedUris: new Set(),
          label: OUTSIDE_PROJECT_LABEL,
          outsideOfProject: true,
          cacheKey: `outside:${OUTSIDE_PROJECT_ID}`,
          workspaceKey: OUTSIDE_PROJECT_ID,
        };
      }

      const normalizedUris = new Set<string>(activeSummary.normalizedWorkspaceUris);
      const projectId = activeSummary.projectId || null;
      let label = "";
      if (projectId && projects.has(projectId)) {
        const proj = projects.get(projectId)!;
        label = proj.name;
        for (const u of proj.normalizedUris) normalizedUris.add(u);
      }
      if (!label) {
        label =
          activeSummary.projectFromFts ||
          basenameOfPath(activeSummary.workspaceUris[0] || "") ||
          "Workspace";
      }

      if (projectId || normalizedUris.size > 0) {
        const workspaceKey = computeWorkspaceKey({
          projectId,
          normalizedUris,
          outsideOfProject: false,
          projects,
        });
        return {
          detected: true,
          projectId,
          normalizedUris,
          label,
          outsideOfProject: false,
          cacheKey: `active:${projectId || ""}:${[...normalizedUris].sort().join("|")}`,
          workspaceKey,
        };
      }
    }

    // 3. 兜底：若 conversation_summaries.db 不可用或尚未索引该会话，则从单会话 .db 安全嗅探
    const inferred = await inferWorkspaceFromDbFallback(
      path.join(conversationsDir, `${activeSessionId}.db`),
      projects,
    );
    if (inferred) {
      const normalizedUris = new Set<string>([inferred.normalizedUri]);
      const workspaceKey = computeWorkspaceKey({
        projectId: inferred.projectId,
        normalizedUris,
        outsideOfProject: false,
        projects,
      });
      return {
        detected: true,
        projectId: inferred.projectId,
        normalizedUris,
        label: inferred.label,
        outsideOfProject: false,
        cacheKey: `fallback:${inferred.projectId || ""}:${inferred.normalizedUri}`,
        workspaceKey,
      };
    }
  }

  return {
    detected: false,
    projectId: null,
    normalizedUris: new Set(),
    label: "All Workspaces",
    outsideOfProject: false,
    cacheKey: "none",
    workspaceKey: "__all__",
  };
}

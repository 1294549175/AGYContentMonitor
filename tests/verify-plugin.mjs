/**
 * Antigravity Context Monitor 自动化回归测试套件。
 * 用途：离线验证 workspace.ts、scanner.ts、quota.ts 的核心解析逻辑与全部历史缺陷修复，
 * 通过 esbuild 将 TypeScript 源码编译到系统临时目录后动态导入执行，结束后自动清理临时目录。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

/**
 * 将指定 TypeScript 源码打包为临时 ESM 文件并动态导入，便于单测直接调用导出函数
 */
async function buildAndImport(tmpDir, relSrcPath, outName) {
  const outFile = path.join(tmpDir, outName);
  await esbuild.build({
    entryPoints: [path.join(PROJECT_ROOT, relSrcPath)],
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["node:sqlite"],
    outfile: outFile,
  });
  return import(pathToFileURL(outFile).href);
}

/**
 * 执行单个命名测试用例并输出清晰结果
 */
async function runCase(name, fn, stats) {
  try {
    await fn();
    stats.passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    stats.failed += 1;
    console.error(`  [FAIL] ${name}`);
    console.error(err);
  }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ctx-mon-test-"));
  const stats = { passed: 0, failed: 0 };

  try {
    console.log("Compiling TypeScript modules for test suite...");
    const [ws, sc, qt] = await Promise.all([
      buildAndImport(tmpDir, "src/workspace.ts", "workspace.mjs"),
      buildAndImport(tmpDir, "src/scanner.ts", "scanner.mjs"),
      buildAndImport(tmpDir, "src/quota.ts", "quota.mjs"),
    ]);

    console.log("Running unit & regression tests...");

    // 1. normalizeFileUri 边界测试
    await runCase(
      "normalizeFileUri: 空格、撇号、中文、字面 %20、大小写 FILE:///、无尾斜杠盘符与 UNC",
      async () => {
        assert.equal(
          ws.normalizeFileUri("file:///c%3A/Project/Sid%20Meier%27s%20Civilization%205/"),
          "c:/project/sid meier's civilization 5",
        );
        assert.equal(
          ws.normalizeFileUri("FILE:///C%3A/Project/%E5%90%88%E5%90%8C/"),
          "c:/project/合同",
        );
        assert.equal(ws.normalizeFileUri("C:\\Project\\合同\\"), "c:/project/合同");
        assert.equal(
          ws.normalizeFileUri("C:\\Project\\foo%20bar\\"),
          "c:/project/foo%20bar",
          "普通本地路径不应执行 decodeURIComponent 破坏字面 %20",
        );
        assert.equal(ws.normalizeFileUri("file:///c%3A"), "c:/");
        assert.equal(ws.normalizeFileUri("FILE:///D%3a"), "d:/");
        assert.equal(ws.normalizeFileUri("\\\\Server01\\Share\\Repo\\"), "//server01/share/repo");
        assert.equal(ws.normalizeFileUri("file://Server01/Share/Repo/"), "//server01/share/repo");
        assert.equal(ws.normalizeFileUri("   "), "");
      },
      stats,
    );

    // 2. parseAnnotationMeta & unescapePbtxtString 词法解析测试
    await runCase(
      "parseAnnotationMeta: 标题含 archived: true 防误伤、八进制 UTF-8 反转义与 side_question_cascade_ids",
      async () => {
        const pbtxt = [
          'title: "修复 \\"archived: true\\" 与 last_user_view_time: {seconds: 1} \\\\ \\345\\220\\210\\345\\220\\214"',
          "last_user_view_time: { nanos: 654000000 seconds: 1795446917 }",
          'side_question_cascade_ids: "c9951c84-ec4d-4e4e-9265-45ce83e2263e"',
          'side_question_cascade_ids: ["sq-second-0001", "sq-third-0002"]',
        ].join("\n");

        const annFile = path.join(tmpDir, "sample.pbtxt");
        fs.writeFileSync(annFile, pbtxt, "utf8");
        const meta = await sc.parseAnnotationMeta(annFile, 123456);

        assert.equal(meta.archived, false, "标题字符串内的 archived: true 不应误判为归档");
        assert.equal(meta.viewMs, 1795446917654, "应兼容 nanos 在 seconds 之前的顺序");
        assert.equal(
          meta.title,
          '修复 "archived: true" 与 last_user_view_time: {seconds: 1} \\ 合同',
        );
        assert.deepEqual(meta.sideQuestionIds, [
          "c9951c84-ec4d-4e4e-9265-45ce83e2263e",
          "sq-second-0001",
          "sq-third-0002",
        ]);

        const archivedMeta = sc.parseAnnotationMetaFromText('title:"正常标题" archived: true', 99);
        assert.equal(archivedMeta.archived, true);
      },
      stats,
    );

    // 3. parseTranscriptMetrics 增量解析、CHECKPOINT 压缩重置与 step_index 边界测试
    await runCase(
      "parseTranscriptMetrics: 增量解析与全量一致、CHECKPOINT 压缩重置、step_index 0/null/空串与半截行",
      async () => {
        const logPath = path.join(tmpDir, "transcript.jsonl");
        const cache = new Map();

        const l1 =
          JSON.stringify({
            type: "USER_INPUT",
            content: "<USER_REQUEST>测试压缩与增量解析</USER_REQUEST>",
          }) + "\n";
        const l2 =
          JSON.stringify({
            type: "GENERIC",
            content: "x".repeat(2048),
          }) + "\n";
        const l3 =
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            step_index: 0,
            input_tokens: 4277,
            cache_read_tokens: 234964,
            output_tokens: 512,
            tool_calls: [{ name: "read_file" }],
          }) + "\n";
        const l4 =
          JSON.stringify({
            type: "CHECKPOINT",
            step_index: null,
            input_tokens: 4277,
            cache_read_tokens: 234964,
            output_tokens: 4517,
          }) + "\n";
        const l5Full = JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: "",
          input_tokens: 800,
          cache_read_tokens: 4500,
          output_tokens: 200,
          status: "DONE",
          tool_calls: [],
        });

        // 阶段 1：写入初始 3 行
        fs.writeFileSync(logPath, l1 + l2 + l3, "utf8");
        let st = fs.statSync(logPath);
        let parsed = await sc.parseTranscriptMetrics(logPath, st.mtimeMs, st.size, cache);
        assert.equal(parsed.title, "测试压缩与增量解析");
        assert.equal(parsed.activeContextTokens, 239241);
        assert.equal(parsed.stepIndex, 0, "step_index === 0 不应被误判为假值");
        assert.equal(parsed.compacted, false);
        assert.equal(parsed.lastEntryRunning, true);

        // 阶段 2：追加 CHECKPOINT 行
        fs.appendFileSync(logPath, l4, "utf8");
        st = fs.statSync(logPath);
        parsed = await sc.parseTranscriptMetrics(logPath, st.mtimeMs + 10, st.size, cache);
        assert.equal(parsed.activeContextTokens, 4517, "CHECKPOINT 应将上下文重置为 output_tokens");
        assert.equal(parsed.freshInputTokens, 4517);
        assert.equal(parsed.cacheReadTokens, 0);
        assert.equal(parsed.compacted, true);
        assert.equal(parsed.stepIndex, 1, "step_index 为 null 时应自增");
        assert.equal(parsed.lastEntryRunning, false);

        // 阶段 3：模拟半截行写入，再补齐后半段（无尾换行）
        const splitAt = Math.floor(l5Full.length / 2);
        fs.appendFileSync(logPath, l5Full.slice(0, splitAt), "utf8");
        st = fs.statSync(logPath);
        parsed = await sc.parseTranscriptMetrics(logPath, st.mtimeMs + 20, st.size, cache);
        assert.equal(parsed.compacted, true, "未写完的半截行不应破坏既有状态");

        fs.appendFileSync(logPath, l5Full.slice(splitAt), "utf8");
        st = fs.statSync(logPath);
        const incParsed = await sc.parseTranscriptMetrics(logPath, st.mtimeMs + 30, st.size, cache);
        const fullParsed = await sc.parseTranscriptMetrics(
          logPath,
          st.mtimeMs + 30,
          st.size,
          new Map(),
        );
        assert.deepEqual(incParsed, fullParsed, "增量追加解析结果必须与全量从头解析完全一致");
        assert.equal(incParsed.activeContextTokens, 5300);
        assert.equal(incParsed.compacted, false);
        assert.equal(incParsed.stepIndex, 2, "step_index 为空串时应自增");
      },
      stats,
    );

    // 4. selectActiveSessionId 平局裁决测试
    await runCase(
      "selectActiveSessionId: viewMs 打平时按 lastUserInputMs 与 previousActiveId 粘性确定性裁决",
      async () => {
        const makeCand = (id, viewMs, lastUserInputMs, annMtimeMs, opts = {}) => ({
          id,
          transcriptPath: "",
          mtimeMs: 1000,
          size: 100,
          viewMs,
          annMtimeMs,
          annTitle: null,
          archived: Boolean(opts.archived),
          score: viewMs,
          summary: {
            lastUserInputMs,
            status: opts.status || "",
            notFullyIdle: Boolean(opts.notFullyIdle),
            killed: false,
          },
        });

        const a = makeCand("e4e66f6c-1111", 10000, 9500, 100);
        const b = makeCand("71d5da81-2222", 10000, 9000, 9999);
        assert.equal(
          sc.selectActiveSessionId([a, b], null),
          "e4e66f6c-1111",
          "viewMs 相同时应优先 lastUserInputMs 更大者，不受 annMtimeMs 落盘顺序干扰",
        );

        const bSameInput = makeCand("71d5da81-2222", 10000, 9500, 9999);
        assert.equal(
          sc.selectActiveSessionId([bSameInput, a], "e4e66f6c-1111"),
          "e4e66f6c-1111",
          "viewMs 与 lastUserInputMs 均打平时应保持 previousActiveId 粘性",
        );

        const archivedHigher = makeCand("ffff0000-3333", 99999, 99999, 99999, { archived: true });
        assert.equal(
          sc.selectActiveSessionId([archivedHigher, a], null),
          "e4e66f6c-1111",
          "归档会话不应被选为活跃会话",
        );
      },
      stats,
    );

    // 5. fileContainsAnyFallback & containsUriBoundary 中文与边界测试
    await runCase(
      "fileContainsAnyFallback: 中文路径 UTF-8 匹配、np 不误匹配 np 2/np中文、子路径与二进制边界",
      async () => {
        assert.equal(
          ws.containsUriBoundary('{"path":"c:/project/np/src/app.ts"}', "c:/project/np", true),
          true,
        );
        assert.equal(
          ws.containsUriBoundary('{"path":"c:/project/np 2/src/app.ts"}', "c:/project/np", true),
          false,
        );
        assert.equal(
          ws.containsUriBoundary('{"path":"c:/project/np中文/src/app.ts"}', "c:/project/np", true),
          false,
        );
        assert.equal(
          ws.containsUriBoundary("file:///c:/project/np/sub", "file:///c:/project/np", false),
          false,
          "二进制 .db 模式下拒绝紧邻 /，避免父目录误吞子目录工作区",
        );

        const utf8Log = path.join(tmpDir, "utf8-transcript.jsonl");
        fs.writeFileSync(
          utf8Log,
          '{"path":"C:\\\\Project\\\\合同\\\\协议.md"}\n{"path":"C:\\\\Project\\\\np 2\\\\index.ts"}\n{"path":"C:\\\\Project\\\\np中文\\\\index.ts"}\n',
          "utf8",
        );
        assert.equal(
          await ws.fileContainsAnyFallback(utf8Log, ["c:/project/合同"], false),
          true,
          "UTF-8 文本模式应正常匹配中文工作区路径",
        );
        assert.equal(
          await ws.fileContainsAnyFallback(utf8Log, ["c:/project/np"], false),
          false,
          "不应误匹配 np 2 或 np中文",
        );
      },
      stats,
    );

    // 6. quota.ts 测试：0% 省略字段、normalizeLsAddr、并发去重、失败陈旧缓存与退避
    await runCase(
      "quota.ts: toWindowInfo 0% 省略字段、normalizeLsAddr、并发去重、超时失败保留陈旧缓存与退避",
      async () => {
        assert.deepEqual(
          qt.toWindowInfo({ window: "5h", resetTime: "2026-11-24T15:00:00Z" }),
          { remainingPct: 0, resetTime: "2026-11-24T15:00:00Z" },
          "Protobuf3 省略值为 0 的 remainingFraction 时应按 0% 处理",
        );
        assert.equal(qt.toWindowInfo({}), null);

        assert.equal(qt.normalizeLsAddr("http://127.0.0.1:43210/"), "127.0.0.1:43210");
        assert.equal(qt.normalizeLsAddr("HTTPS://localhost:8080///"), "localhost:8080");

        qt.resetQuotaStateForTest();
        let queryCount = 0;
        const mockGroups = [
          {
            id: "gemini-0",
            label: "Gemini",
            fiveHour: { remainingPct: 75, resetTime: "" },
            weekly: null,
          },
        ];
        const discoverFn = async () => [{ addr: "http://127.0.0.1:12345/", csrfToken: "tok" }];
        const slowOk = async () => {
          queryCount += 1;
          await new Promise((r) => setTimeout(r, 30));
          return mockGroups;
        };

        const [r1, r2] = await Promise.all([
          qt.fetchQuotaSummary({}, { queryFn: slowOk, discoverFn }),
          qt.fetchQuotaSummary({}, { queryFn: slowOk, discoverFn }),
        ]);
        assert.equal(queryCount, 1, "并发非强刷请求应去重为 1 次");
        assert.equal(r1.stale, false);
        assert.deepEqual(r1.groups, mockGroups);
        assert.deepEqual(r2.groups, mockGroups);

        let failCount = 0;
        const failFn = async () => {
          failCount += 1;
          return null;
        };
        const staleRes = await qt.fetchQuotaSummary(
          { forceRefresh: true },
          { queryFn: failFn, discoverFn },
        );
        assert.equal(staleRes.stale, true, "超时/失败时应回退 5 分钟内陈旧缓存而非清空");
        assert.deepEqual(staleRes.groups, mockGroups);
        assert.ok(failCount >= 1);

        const beforeBackoff = failCount;
        const backoffRes = await qt.fetchQuotaSummary({}, { queryFn: failFn, discoverFn });
        assert.equal(backoffRes.stale, true);
        assert.equal(failCount, beforeBackoff, "10 秒退避期内不应重复发起探测");
      },
      stats,
    );

    // 7. collectAvailableWorkspaces & resolveActiveWorkspace 手动锁定测试
    await runCase(
      "workspace: collectAvailableWorkspaces 聚合排序与 resolveActiveWorkspace 手动锁定",
      async () => {
        const projects = new Map([
          [
            "proj-a",
            { id: "proj-a", name: "Alpha", normalizedUris: ["c:/project/alpha"] },
          ],
          [
            "proj-b",
            { id: "proj-b", name: "Beta", normalizedUris: ["c:/project/beta"] },
          ],
        ]);
        const options = ws.collectAvailableWorkspaces({
          summaries: null,
          projects,
          visibleCandidates: [
            { projectId: "proj-b", workspaceName: "Beta", normalizedUris: ["c:/project/beta"], outsideOfProject: false },
            { projectId: "proj-a", workspaceName: "Alpha", normalizedUris: ["c:/project/alpha"], outsideOfProject: false },
            { projectId: "proj-b", workspaceName: "Beta", normalizedUris: ["c:/project/beta"], outsideOfProject: false },
            { projectId: ws.OUTSIDE_PROJECT_ID, workspaceName: "独立对话", normalizedUris: [], outsideOfProject: true },
          ],
        });
        assert.deepEqual(
          options.map((o) => [o.key, o.sessionCount]),
          [
            ["project:proj-b", 2],
            ["project:proj-a", 1],
            [ws.OUTSIDE_PROJECT_ID, 1],
          ],
        );

        const pinnedA = await ws.resolveActiveWorkspace({
          activeSessionId: null,
          summaries: null,
          projects,
          hostPaths: [],
          hostUris: [],
          conversationsDir: "",
          pinnedWorkspaceKey: "project:proj-a",
        });
        assert.equal(pinnedA.detected, true);
        assert.equal(pinnedA.label, "Alpha");
        assert.equal(pinnedA.workspaceKey, "project:proj-a");

        const pinnedAll = await ws.resolveActiveWorkspace({
          activeSessionId: null,
          summaries: null,
          projects,
          hostPaths: [],
          hostUris: [],
          conversationsDir: "",
          pinnedWorkspaceKey: "__all__",
        });
        assert.equal(pinnedAll.detected, false);
        assert.equal(pinnedAll.workspaceKey, "__all__");
      },
      stats,
    );

    console.log(`\nTest summary: ${stats.passed} passed, ${stats.failed} failed.`);
    if (stats.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

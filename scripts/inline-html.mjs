import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const PLACEHOLDER = "<!--__UI_SCRIPT__-->";

/**
 * 将编译压缩后的前端脚本内联写入模板 HTML，生成单文件 MCP App 产物 dist/app.html。
 * 使用基于 import.meta.url 解析的项目根目录，确保无论从何处调用脚本均能定位准确路径。
 */
function buildInlineAppHtml() {
  const templatePath = path.join(PROJECT_ROOT, "src", "template.html");
  const uiBundlePath = path.join(PROJECT_ROOT, "dist", "ui.js");
  const distDir = path.join(PROJECT_ROOT, "dist");
  const outputPath = path.join(distDir, "app.html");

  const template = fs.readFileSync(templatePath, "utf8");
  if (!template.includes(PLACEHOLDER)) {
    throw new Error(`模板文件缺少脚本占位符 ${PLACEHOLDER}: ${templatePath}`);
  }

  const js = fs.readFileSync(uiBundlePath, "utf8");
  const html = template.replace(PLACEHOLDER, () => `<script type="module">\n${js}\n</script>`);

  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
  console.log(`Built ${path.relative(PROJECT_ROOT, outputPath)} (${Buffer.byteLength(html, "utf8")} bytes)`);
}

buildInlineAppHtml();

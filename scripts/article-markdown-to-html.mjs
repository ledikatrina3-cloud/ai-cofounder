import { readFile, writeFile } from "node:fs/promises";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error("Usage: node scripts/article-markdown-to-html.mjs <input.md> <output.html>");
}

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const inline = (value) =>
  escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');

const source = await readFile(input, "utf8");
const body = source.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
const lines = body.split("\n");
const out = [];

let paragraph = [];
let listType = null;
let inCode = false;
let code = [];

const flushParagraph = () => {
  if (paragraph.length) out.push(`<p>${inline(paragraph.join(" "))}</p>`);
  paragraph = [];
};

const closeList = () => {
  if (listType) out.push(`</${listType}>`);
  listType = null;
};

for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];

  if (line.startsWith("```")) {
    flushParagraph();
    closeList();
    if (inCode) {
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      code = [];
    }
    inCode = !inCode;
    continue;
  }
  if (inCode) {
    code.push(line);
    continue;
  }

  if (!line.trim()) {
    flushParagraph();
    closeList();
    continue;
  }

  const heading = line.match(/^(#{1,2})\s+(.+)$/);
  if (heading) {
    flushParagraph();
    closeList();
    const level = heading[1].length;
    out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    continue;
  }

  if (line.startsWith("> ")) {
    flushParagraph();
    closeList();
    out.push(`<blockquote><p>${inline(line.slice(2))}</p></blockquote>`);
    continue;
  }

  const unordered = line.match(/^[-*]\s+(.+)$/);
  const ordered = line.match(/^\d+\.\s+(.+)$/);
  if (unordered || ordered) {
    flushParagraph();
    const nextType = unordered ? "ul" : "ol";
    if (listType !== nextType) {
      closeList();
      listType = nextType;
      out.push(`<${listType}>`);
    }
    out.push(`<li>${inline((unordered || ordered)[1])}</li>`);
    continue;
  }

  if (line.startsWith("|") && lines[index + 1]?.match(/^\|?[\s:|-]+\|/)) {
    flushParagraph();
    closeList();
    const tableLines = [line];
    index += 2;
    while (index < lines.length && lines[index].startsWith("|")) {
      tableLines.push(lines[index]);
      index += 1;
    }
    index -= 1;
    const rows = tableLines.map((row) =>
      row
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
    out.push("<table><thead><tr>");
    for (const cell of rows[0]) out.push(`<th>${inline(cell)}</th>`);
    out.push("</tr></thead><tbody>");
    for (const row of rows.slice(1)) {
      out.push("<tr>");
      for (const cell of row) out.push(`<td>${inline(cell)}</td>`);
      out.push("</tr>");
    }
    out.push("</tbody></table>");
    continue;
  }

  paragraph.push(line.trim());
}

flushParagraph();
closeList();

await writeFile(output, `${out.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ status: "ok", input, output }));

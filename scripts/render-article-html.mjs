import { readFile, writeFile } from 'node:fs/promises';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error('Usage: node scripts/render-article-html.mjs <input.md> <output.html>');
}

const escapeHtml = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const inline = (value) =>
  escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

const source = await readFile(input, 'utf8');
const body = source.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
const lines = body.split('\n');
const html = [];
let list = null;
let paragraph = [];

const flushParagraph = () => {
  if (paragraph.length) html.push(`<p>${inline(paragraph.join(' '))}</p>`);
  paragraph = [];
};
const closeList = () => {
  if (list) html.push(`</${list}>`);
  list = null;
};

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const singleLineCode = line.match(/^<pre><code>(.*)<\/code><\/pre>$/);
  const fencedCode = line.match(/^```(?:\w+)?\s*$/);
  if (fencedCode) {
    flushParagraph();
    closeList();
    const code = [];
    while (++i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i]);
    html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  } else if (singleLineCode) {
    flushParagraph();
    closeList();
    html.push(`<pre><code>${escapeHtml(singleLineCode[1])}</code></pre>`);
  } else if (line === '<pre><code>') {
    flushParagraph();
    closeList();
    const code = [];
    while (++i < lines.length && lines[i] !== '</code></pre>') code.push(lines[i]);
    html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  } else if (line.startsWith('# ')) {
    flushParagraph();
    closeList();
    html.push(`<h1>${inline(line.slice(2))}</h1>`);
  } else if (line.startsWith('## ')) {
    flushParagraph();
    closeList();
    html.push(`<h2>${inline(line.slice(3))}</h2>`);
  } else if (/^\d+\. /.test(line)) {
    flushParagraph();
    if (list !== 'ol') {
      closeList();
      list = 'ol';
      html.push('<ol>');
    }
    html.push(`<li>${inline(line.replace(/^\d+\. /, ''))}</li>`);
  } else if (line.startsWith('- ')) {
    flushParagraph();
    if (list !== 'ul') {
      closeList();
      list = 'ul';
      html.push('<ul>');
    }
    html.push(`<li>${inline(line.slice(2))}</li>`);
  } else if (line.startsWith('> ')) {
    flushParagraph();
    closeList();
    html.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
  } else if (line.trim() === '') {
    flushParagraph();
    closeList();
  } else if (list && html.at(-1)?.startsWith('<li>')) {
    html[html.length - 1] = html.at(-1).replace('</li>', ` ${inline(line.trim())}</li>`);
  } else {
    paragraph.push(line.trim());
  }
}
flushParagraph();
closeList();
await writeFile(output, `${html.join('\n')}\n`, 'utf8');
console.log(JSON.stringify({ status: 'ok', input, output, blocks: html.length }));

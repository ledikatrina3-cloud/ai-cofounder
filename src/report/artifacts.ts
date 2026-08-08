import { stat } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';

export type ReportArtifactKind = 'article' | 'html' | 'cover';
export type TelegramArtifactMethod = 'photo' | 'document';

export interface ReportArtifact {
  kind: ReportArtifactKind;
  path: string;
  fileName: string;
  telegramMethod: TelegramArtifactMethod;
}

export interface StatLike {
  size: number;
  isFile: () => boolean;
}

export interface ResolveReportArtifactsDeps {
  rootDir?: string;
  statFile?: (path: string) => Promise<StatLike>;
  maxBytes?: number;
}

export interface ArtifactBotApi {
  sendPhoto: (
    chatId: string | number,
    file: unknown,
    opts?: { caption?: string },
  ) => Promise<unknown>;
  sendDocument: (
    chatId: string | number,
    file: unknown,
    opts?: { caption?: string },
  ) => Promise<unknown>;
}

const DEFAULT_MAX_BYTES = 45 * 1024 * 1024;
const ARTIFACT_LINE_RE =
  /^\s*(?:[-*]\s*)?(?:\*\*)?(article|markdown|md|html|cover|image)(?:\*\*)?\s*[:=-]\s*`?([^`\s]+)`?/i;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.svg']);

export async function resolveReportArtifacts(
  text: string,
  deps: ResolveReportArtifactsDeps = {},
): Promise<ReportArtifact[]> {
  const rootDir = deps.rootDir ?? process.cwd();
  const contentRoot = resolve(rootDir, 'content');
  const statFile = deps.statFile ?? ((path: string) => stat(path));
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const seen = new Set<string>();
  const artifacts: ReportArtifact[] = [];

  for (const line of text.split('\n')) {
    const match = ARTIFACT_LINE_RE.exec(line);
    if (match === null) continue;

    const label = (match[1] ?? '').toLowerCase();
    const rawPath = cleanArtifactPath(match[2] ?? '');
    const absPath = resolve(rootDir, rawPath);
    if (!isInside(absPath, contentRoot)) continue;
    if (seen.has(absPath)) continue;

    const ext = extname(absPath).toLowerCase();
    const kind = classifyArtifact(label, ext);
    if (kind === null) continue;

    let fileStat: StatLike;
    try {
      fileStat = await statFile(absPath);
    } catch {
      continue;
    }
    if (!fileStat.isFile() || fileStat.size > maxBytes) continue;

    seen.add(absPath);
    artifacts.push({
      kind,
      path: absPath,
      fileName: basename(absPath),
      telegramMethod: telegramMethodFor(ext),
    });
  }

  return artifacts;
}

export async function sendReportArtifacts(
  chatId: string | number,
  artifacts: ReportArtifact[],
  botApi: ArtifactBotApi,
  makeInputFile: (path: string) => unknown = (path) => path,
): Promise<void> {
  for (const artifact of artifacts) {
    const file = makeInputFile(artifact.path);
    const caption = artifactCaption(artifact);
    if (artifact.telegramMethod === 'photo') {
      await botApi.sendPhoto(chatId, file, { caption });
    } else {
      await botApi.sendDocument(chatId, file, { caption });
    }
  }
}

function cleanArtifactPath(raw: string): string {
  return raw.trim().replace(/^['\"]|['\"),;]+$/g, '');
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

function classifyArtifact(label: string, ext: string): ReportArtifactKind | null {
  if (ext === '.html') return 'html';
  if (ext === '.md' && label !== 'cover' && label !== 'image') return 'article';
  if (IMAGE_EXTENSIONS.has(ext) && (label === 'cover' || label === 'image')) return 'cover';
  return null;
}

function telegramMethodFor(ext: string): TelegramArtifactMethod {
  return ext === '.png' || ext === '.jpg' || ext === '.jpeg' ? 'photo' : 'document';
}

function artifactCaption(artifact: ReportArtifact): string {
  switch (artifact.kind) {
    case 'article':
      return `Article: ${artifact.fileName}`;
    case 'html':
      return `HTML: ${artifact.fileName}`;
    case 'cover':
      return `Cover: ${artifact.fileName}`;
  }
}

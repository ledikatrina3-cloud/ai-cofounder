// Tool: project.read / project.grep / project.glob
//
// Фаза 2.1 — файловый доступ к проекту для routine sub-agent.
//
// Безопасность:
//   * Все пути нормализуются через path.resolve и проверяются на вхождение
//     в projectPath (path traversal → ProjectToolPermissionError).
//   * Абсолютный путь вне projectPath → тоже ProjectToolPermissionError.
//   * project.grep запускает `rg` с CWD=projectPath — rg сам ограничен
//     своей CWD и не может вылезти наружу.
//   * project.glob через fast-glob c CWD=projectPath; результаты фильтруются
//     на отсутствие ведущих '..'.
//
// Зависимости:
//   * fast-glob (уже в package.json со времён 1.2)
//   * ripgrep (rg) — нативный бинарник на маке фаундера
//   * node:fs/promises, node:path, node:child_process — только stdlib

import { execFile } from 'node:child_process';
import { access, lstat, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import fg from 'fast-glob';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Ошибки

export class ProjectToolError extends Error {
  constructor(
    public readonly toolName: string,
    message: string,
  ) {
    super(`${toolName}: ${message}`);
    this.name = 'ProjectToolError';
  }
}

export class ProjectToolPermissionError extends ProjectToolError {
  constructor(toolName: string, path: string) {
    super(toolName, `доступ запрещён: путь '${path}' выходит за пределы проекта.`);
    this.name = 'ProjectToolPermissionError';
  }
}

export class ProjectToolNotFoundError extends ProjectToolError {
  constructor(toolName: string, path: string) {
    super(toolName, `файл не найден: '${path}'.`);
    this.name = 'ProjectToolNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Типы

export interface GrepResult {
  file: string; // relative path к projectPath
  line: number;
  text: string; // trimmed content строки
}

// ---------------------------------------------------------------------------
// Константы

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Вспомогательные функции

/**
 * Гарантирует, что resolvedPath находится внутри projectPath.
 * Кидает ProjectToolPermissionError если это не так.
 */
function assertInsideProject(
  toolName: string,
  projectPath: string,
  resolvedPath: string,
  originalRelPath: string,
): void {
  // Нормализуем projectPath (без trailing sep, чтобы не было двойного сравнения)
  const projectBase = projectPath.endsWith(sep) ? projectPath : `${projectPath}${sep}`;
  const isInside = resolvedPath === projectPath || resolvedPath.startsWith(projectBase);
  if (!isInside) {
    throw new ProjectToolPermissionError(toolName, originalRelPath);
  }
}

/**
 * Находит путь к бинарнику rg. Пробует:
 * 1. Системный PATH через `which rg` (child_process execFile)
 * 2. Homebrew пути
 * 3. Встроенный в Cursor/claude-agent-sdk (для dev-среды)
 */
async function findRgBinary(): Promise<string> {
  // Список кандидатов для прямого доступа
  const candidates = [
    '/usr/local/bin/rg',
    '/opt/homebrew/bin/rg',
    '/usr/bin/rg',
    // Fallback: claude-agent-sdk bundle (Cursor dev env)
    '/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-agent/dist/claude-agent-sdk/vendor/ripgrep/arm64-darwin/rg',
    '/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-agent/dist/claude-agent-sdk/vendor/ripgrep/x64-darwin/rg',
    '/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg',
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // не найден, пробуем следующий
    }
  }

  // Финальный fallback: 'rg' из PATH (если вдруг в PATH есть)
  return 'rg';
}

// ---------------------------------------------------------------------------
// projectRead

/**
 * Читает файл по relPath внутри projectPath.
 *
 * @param projectPath - абсолютный путь к корню проекта
 * @param relPath - относительный путь внутри проекта (или абсолютный — проверяется)
 * @returns utf-8 содержимое файла
 * @throws ProjectToolPermissionError — если путь выходит за пределы projectPath
 * @throws ProjectToolNotFoundError — если файл не существует
 * @throws ProjectToolError — если файл > 1 MB
 */
export async function projectRead(projectPath: string, relPath: string): Promise<string> {
  const resolvedPath = resolve(projectPath, relPath);
  assertInsideProject('project.read', projectPath, resolvedPath, relPath);

  // Проверяем существование файла через lstat (не следует за symlinks).
  // stat() следует за symlink → /project/evil -> /etc → читает /etc/passwd.
  let fileStat: Awaited<ReturnType<typeof lstat>>;
  try {
    const lstats = await lstat(resolvedPath);
    if (lstats.isSymbolicLink()) {
      // Symlink внутри проекта может вести за его пределы — запрещаем.
      throw new ProjectToolPermissionError('project.read', relPath);
    }
    fileStat = lstats;
  } catch (e) {
    if (e instanceof ProjectToolPermissionError) throw e;
    throw new ProjectToolNotFoundError('project.read', relPath);
  }

  if (!fileStat.isFile()) {
    throw new ProjectToolNotFoundError('project.read', relPath);
  }

  // Проверяем размер
  if (fileStat.size > MAX_FILE_SIZE) {
    throw new ProjectToolError('project.read', 'файл слишком большой для чтения');
  }

  const content = await readFile(resolvedPath, 'utf-8');
  return content;
}

// ---------------------------------------------------------------------------
// projectGrep

export interface ProjectGrepOptions {
  caseSensitive?: boolean;
  maxResults?: number;
  fileGlob?: string;
}

// rg JSON output types (только нужные нам)
interface RgMatchPath {
  text: string;
}
interface RgMatchLines {
  text: string;
}
interface RgMatch {
  type: 'match';
  data: {
    path: RgMatchPath;
    line_number: number;
    lines: RgMatchLines;
  };
}
interface RgOther {
  type: 'begin' | 'end' | 'summary' | 'context';
}
type RgLine = RgMatch | RgOther;

/**
 * Ищет pattern в файлах проекта через ripgrep.
 *
 * @param projectPath - абсолютный путь к корню проекта (cwd для rg)
 * @param pattern - регулярное выражение или строка поиска
 * @param options - опции поиска
 * @returns массив результатов (может быть пустым)
 * @throws ProjectToolError — если rg не установлен
 */
export async function projectGrep(
  projectPath: string,
  pattern: string,
  options: ProjectGrepOptions = {},
): Promise<GrepResult[]> {
  const { caseSensitive = false, maxResults = 50, fileGlob } = options;

  const caseSensitiveArgs = caseSensitive ? ['--case-sensitive'] : ['--ignore-case'];
  const globArgs = fileGlob ? ['-g', fileGlob] : [];

  const args = [
    '--json',
    '--max-count',
    String(maxResults),
    ...caseSensitiveArgs,
    ...globArgs,
    pattern,
    '.',
  ];

  let stdout: string;
  try {
    const rgBinary = await findRgBinary();
    const result = await execFileAsync(rgBinary, args, {
      cwd: projectPath,
      maxBuffer: 10 * 1024 * 1024, // 10 MB буфер для stdout
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    // execFile-ошибка: code — строковый errno-код ('ENOENT') или числовой exit code.
    // Приводим через unknown, чтобы TypeScript не спорил об overlap string/number.
    const e = err as { code?: unknown; stdout?: string; message?: string };

    // rg не найден
    if (e.code === 'ENOENT') {
      throw new ProjectToolError(
        'project.grep',
        'rg не установлен. Установи ripgrep: brew install ripgrep',
      );
    }

    // rg возвращает exit code 1 если ничего не найдено — это не ошибка
    if (Number(e.code) === 1 && typeof e.stdout === 'string') {
      stdout = e.stdout;
    } else if (typeof e.stdout === 'string' && e.stdout.length > 0) {
      stdout = e.stdout;
    } else {
      // Реальная ошибка
      throw new ProjectToolError('project.grep', `ошибка rg: ${e.message ?? String(err)}`);
    }
  }

  const results: GrepResult[] = [];
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);

  for (const line of lines) {
    let parsed: RgLine;
    try {
      parsed = JSON.parse(line) as RgLine;
    } catch {
      continue; // нераспознанная строка, пропускаем
    }

    if (parsed.type !== 'match') continue;

    const match = parsed as RgMatch;
    const filePath = match.data.path.text;

    // Фильтруем результаты вне projectPath (дополнительная защита)
    const resolvedFile = resolve(projectPath, filePath);
    const projectBase = projectPath.endsWith(sep) ? projectPath : `${projectPath}${sep}`;
    if (resolvedFile !== projectPath && !resolvedFile.startsWith(projectBase)) {
      continue; // вне проекта — фильтруем
    }

    results.push({
      file: filePath,
      line: match.data.line_number,
      text: match.data.lines.text.trimEnd(),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// projectGlob

export interface ProjectGlobOptions {
  maxResults?: number;
}

/**
 * Возвращает список файлов/директорий по glob-паттерну внутри projectPath.
 *
 * @param projectPath - абсолютный путь к корню проекта (cwd для fast-glob)
 * @param pattern - glob-паттерн (например, '**\/*.ts')
 * @param options - опции (maxResults)
 * @returns массив относительных путей
 */
export async function projectGlob(
  projectPath: string,
  pattern: string,
  options: ProjectGlobOptions = {},
): Promise<string[]> {
  const { maxResults = 200 } = options;

  const rawResults = await fg(pattern, {
    cwd: projectPath,
    onlyFiles: false,
    dot: false,
  });

  // Фильтруем escape-пути (path traversal через glob)
  const safeResults = rawResults.filter((r) => !r.startsWith('..'));

  // Обрезаем до maxResults
  return safeResults.slice(0, maxResults);
}

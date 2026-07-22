// `pnpm check:engine` — проверяет, вышла ли новая версия движка в upstream.
// Сравнивает локальный VERSION с upstream/main:VERSION. Ничего не меняет:
// только печатает вердикт и (если есть апдейт) подсказывает `pnpm update-engine`.
//
// Пользовательский слой (agents/ org/ ai-clone/) НЕ трекается upstream — апдейт
// движка их не трогает (см. docs/UPDATING.md). Поэтому проверка безопасна и
// читаема: это git fetch + сравнение одного файла, без рабочих изменений.
//
// Граничные случаи (fresh fork): нет remote `upstream`, нет сети, не git-репо —
// печатаем понятную подсказку и выходим с кодом 0 (это не ошибка сборки).

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const UPSTREAM_REMOTE = 'upstream';
const UPSTREAM_BRANCH = 'main';

function readLocalVersion(): string {
  try {
    return readFileSync(resolve(ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

// "1.2.3" → [1, 2, 3]. Нечисловые/недостающие сегменты → 0. Без semver-зависимости.
function parseVersion(v: string): [number, number, number] {
  const parts = v.replace(/^v/, '').split('.');
  const num = (i: number): number => {
    const n = Number.parseInt(parts[i] ?? '0', 10);
    return Number.isFinite(n) ? n : 0;
  };
  return [num(0), num(1), num(2)];
}

// a > b ?
function isNewer(a: string, b: string): boolean {
  const [a0, a1, a2] = parseVersion(a);
  const [b0, b1, b2] = parseVersion(b);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

function git(args: string): string {
  return execSync(`git ${args}`, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function hasUpstreamRemote(): boolean {
  try {
    const remotes = git('remote');
    return remotes.split('\n').some((r) => r.trim() === UPSTREAM_REMOTE);
  } catch {
    return false;
  }
}

function main(): void {
  const local = readLocalVersion();

  if (!hasUpstreamRemote()) {
    console.log(`Локальная версия движка: ${local}`);
    console.log(
      `Remote '${UPSTREAM_REMOTE}' не настроен — не с чем сравнивать. Добавь источник обновлений:`,
    );
    console.log('  git remote add upstream <url-апстрима>');
    console.log('Потом: pnpm check:engine');
    return;
  }

  try {
    execSync(`git fetch ${UPSTREAM_REMOTE} --quiet`, {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    console.log(`Не удалось сделать git fetch ${UPSTREAM_REMOTE} (нет сети?). Локальная: ${local}`);
    return;
  }

  let upstream: string;
  try {
    upstream = git(`show ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}:VERSION`).trim();
  } catch {
    console.log(
      `Не удалось прочитать VERSION из ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}. Локальная: ${local}`,
    );
    return;
  }

  if (isNewer(upstream, local)) {
    console.log(`Доступна новая версия движка: ${upstream} (у тебя ${local}).`);
    console.log('  Обновить:   pnpm update-engine');
    console.log('  Подробнее:  docs/UPDATING.md');
  } else {
    console.log(`Движок актуален (${local}).`);
  }
}

main();

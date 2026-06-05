// useRoutineProgress — вычисляет «на каком этапе» воркер сейчас и процент
// выполнения. Для skill build-guide методология выдаёт 14
// последовательных этапов с под-этапами (1.0-1.8, 6a, 6b, 9a-c, 11a/b,
// 12a/b, 13a/b). Парсим текст assistant.thinking + assistant.message
// regex'ом «Этап N(.|a-d)» и берём максимум — агент не может перескочить
// назад надолго.
//
// Почему текстовый regex, а не explicit emit:
//   • SKILL.md сам пишет «Этап X.Y» в чате через progress markers.
//   • Эмитить отдельные events потребует менять skill в чужом репо
//     (example-project) — out of scope.
//   • Парсер дёшев: O(events) × O(regex), для 500 events это <1ms.
//
// Fallback: если ни одного «Этап X» не найдено в text-events, но есть
// tool.start с характерными командами (psql/pg_dump/git push), оцениваем
// по эвристике (см. STAGE_HEURISTICS).

import { useMemo } from 'react';
import type { BridgeEvent } from '../../../events.js';

export interface RoutineProgress {
  /** Найденный максимальный этап (1..14), 0 если непонятно. */
  stage: number;
  /** Точный strings вида «6b», «1.4», «13a». null если не найдено. */
  stageLabel: string | null;
  /** 0..100. Базируется на (stage / 14). Под-этапы добавляют 0.5/14. */
  percent: number;
}

// Базовая шкала — 14 этапов методологии. Под-этапы (1.1, 6a, 9c) приравниваем
// к «X.5» внутри своей фазы — то есть прогресс растёт плавнее.
const TOTAL_STAGES = 14;

const STAGE_REGEX = /этап\s*(\d{1,2})\s*([.,]\s*(\d{1,2})|([a-dA-DА-Га-г]))?/gi;

// Эвристика по tool calls если regex не сработал (skill не пишет markers'ы
// текстом или они уехали из event buffer'а).
const TOOL_HEURISTICS: Array<{ pattern: RegExp; stage: number; label: string }> = [
  { pattern: /pg_dump|prod-psql|docker exec.*production|indexnow/i, stage: 12, label: '12 (prod)' },
  { pattern: /generate-hero|nano banana|gemini/i, stage: 9, label: '9b (hero)' },
  { pattern: /playwright|browser_/i, stage: 11, label: '11 (playwright)' },
  { pattern: /import\.ts|GUIDES_TARGET=dev|update\.ts/i, stage: 9, label: '9 (dev import)' },
  { pattern: /content\/drafts\/.*\.mdx/i, stage: 6, label: '6 (MDX)' },
  { pattern: /websearch|webfetch|hackernews|reddit|habr/i, stage: 1, label: '1 (research)' },
  { pattern: /content\/drafts\/.*\.checklist\.md/i, stage: 0, label: '0a (checklist)' },
];

function extractStageFromText(text: string): { stage: number; label: string } | null {
  const matches = Array.from(text.matchAll(STAGE_REGEX));
  if (matches.length === 0) return null;
  // Берём последнее упоминание — обычно самое свежее в потоке мысли.
  const last = matches[matches.length - 1];
  if (last === undefined) return null;
  const stage = Number.parseInt(last[1] ?? '0', 10);
  if (!Number.isFinite(stage) || stage < 0 || stage > TOTAL_STAGES) return null;
  const sub = last[3] ?? last[4] ?? '';
  const label =
    sub.length > 0 ? `${stage}${last[3] !== undefined ? `.${last[3]}` : sub}` : String(stage);
  return { stage, label };
}

function extractStageFromTool(
  name: string,
  input: unknown,
): { stage: number; label: string } | null {
  let cmd = '';
  if (typeof input === 'string') cmd = input;
  else if (input !== null && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    cmd = `${String(o.command ?? '')} ${String(o.file_path ?? '')} ${String(o.url ?? '')}`.trim();
  }
  const haystack = `${name} ${cmd}`;
  for (const h of TOOL_HEURISTICS) {
    if (h.pattern.test(haystack)) return { stage: h.stage, label: h.label };
  }
  return null;
}

/**
 * Чистая функция — для unit-тестов. Свернёт events до {stage, percent, label}.
 */
export function computeProgress(events: BridgeEvent[], routineId: string): RoutineProgress {
  let maxStage = 0;
  let label: string | null = null;
  let hasSubStage = false;
  let isActive = false;

  for (const ev of events) {
    if (ev.type === 'routine.start' && ev.routineId === routineId) {
      isActive = true;
      maxStage = 0;
      label = null;
      hasSubStage = false;
      continue;
    }
    if (ev.type === 'routine.end' && ev.routineId === routineId) {
      isActive = false;
      // Если завершился ok — считаем 100% (даже если в text не дошёл до «Этап 14»).
      if (ev.status === 'ok') {
        return { stage: TOTAL_STAGES, stageLabel: '14', percent: 100 };
      }
      continue;
    }
    if (!isActive) continue;

    // Текстовые события — primary source.
    if (ev.type === 'assistant.thinking' && ev.workerId === routineId) {
      const found = extractStageFromText(ev.text);
      if (found !== null && found.stage >= maxStage) {
        maxStage = found.stage;
        label = found.label;
        hasSubStage = found.label.length > String(found.stage).length;
      }
    } else if (ev.type === 'assistant.message') {
      const found = extractStageFromText(ev.text);
      if (found !== null && found.stage >= maxStage) {
        maxStage = found.stage;
        label = found.label;
        hasSubStage = found.label.length > String(found.stage).length;
      }
    } else if (ev.type === 'tool.start') {
      // Эвристика по tool — fallback, не перезаписывает text-based finding если он выше.
      const found = extractStageFromTool(ev.name, ev.input);
      if (found !== null && found.stage > maxStage) {
        maxStage = found.stage;
        label = found.label;
        hasSubStage = found.label.includes('(');
      }
    }
  }

  // Под-этап даёт +0.5 в шкале (стабильно растёт прогресс между крупными вехами).
  const fractional = hasSubStage ? maxStage + 0.5 : maxStage;
  const percent = Math.min(100, Math.round((fractional / TOTAL_STAGES) * 100));

  return { stage: maxStage, stageLabel: label, percent };
}

export function useRoutineProgress(events: BridgeEvent[], routineId: string): RoutineProgress {
  return useMemo(() => computeProgress(events, routineId), [events, routineId]);
}

// Department — типы.
//
// Department = команда (несколько employees-routines) + pipeline + бюджет.
// Источник плана: 2026-05-21-skills-architecture-v3, раздел «3. Отдел =
// Department с pipeline и шаблонами», Фаза 5.
//
// Файловый layout:
//   departments/<id>/
//     DEPARTMENT.md      ← frontmatter (name, description, budget) + body
//     pipeline.yml       ← workflow граф
//     shared/            ← общие данные (topics-backlog.md и т.д.)

import type { Pipeline } from '../pipelines/types.js';

export interface DepartmentBudget {
  perDayUsd: number;
  perRunUsd: number;
}

export interface Department {
  /** id = basename папки `departments/<id>/`. kebab-case. */
  id: string;
  /** displayName из DEPARTMENT.md frontmatter. */
  name: string;
  /** Описание из frontmatter (для UI/маркетплейса). */
  description: string;
  /** Опциональный per-day/per-run бюджет (используется pre-call guard'ом). */
  budget?: DepartmentBudget;
  /** Тело DEPARTMENT.md (markdown после frontmatter). */
  body: string;
  /** Абсолютный путь к DEPARTMENT.md. */
  filePath: string;
  /** Абсолютный путь к pipeline.yml. */
  pipelinePath: string;
  /** Распарсенный pipeline. */
  pipeline: Pipeline;
  /** Абсолютный путь к директории shared/. Может не существовать на диске. */
  sharedDir: string;
}

// Skill type contract — Anthropic-совместимый формат с нашими расширениями.
//
// Минимум обязательных полей (`name`, `description`) совпадает с
// https://github.com/anthropics/skills — это даёт портируемость наших
// скиллов в Claude Code и обратно. Всё, что сверху (version, category,
// displayName, icon, color, dependsOn, compatibleWith, requiresScopes),
// — наше расширение для маркетплейса, dependency-резолва и UI.
//
// `permissions` — отдельный блок, читается из `permissions.md` рядом с
// `SKILL.md`. Если файл отсутствует — `permissions = {}`.
//
// `filePath` — абсолютный путь к директории скилла (не к SKILL.md).
// Это нужно registry/runtime'у для резолва `scripts/`, `references/`,
// `assets/` относительно скилла.

import type { SkillCategory } from './categories.js';

// ---------------------------------------------------------------------------
// permissions.md → Permissions.
// ---------------------------------------------------------------------------

export interface SkillApprovalRequest {
  // Имя действия скилла, перед которым нужно подтверждение (например,
  // `publish` для vc-publishing). Совпадает с одним из шагов сценария
  // скилла — runtime использует это для матчинга.
  action: string;
  // Канал подтверждения. На фазе 1 фиксируем `telegram`, но поле строкой —
  // чтобы не ломать парсер при появлении `bridge`/`email` позже.
  via: string;
}

export interface SkillHealthCheck {
  // Путь к скрипту, относительный к директории скилла. Парсер не проверяет
  // существование — это runtime-задача.
  script: string;
  // Cron-expression. На фазе 1 не валидируем строго (cron-parser появится
  // когда runtime начнёт реально расписывать health-check'и).
  schedule: string;
}

export interface SkillPermissions {
  // Bash-префиксы, разрешённые скиллу сверх дефолтного whitelist'а.
  // Жёсткая инвариант: каждый prefix начинается с
  //   `pnpm exec tsx skills/<skill-name>/scripts/`
  // Это держит скиллы как data, не code (см. multi-user решение #1).
  bashWhitelist?: string[];
  // Требуемые SDK tools (Read, Bash, Glob, …). Имена — как у Claude Agent SDK.
  requiredSdkTools?: string[];
  // Максимум шагов внутри одного вызова скилла. Защита от infinite loop.
  maxStepsPerInvocation?: number;
  // Действия, перед которыми скилл обязан попросить human-gate.
  requiresApproval?: SkillApprovalRequest[];
  // Smoke-тест скилла (например, проверка живости провайдера).
  healthCheck?: SkillHealthCheck;
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter → Skill.
// ---------------------------------------------------------------------------

export interface SkillCompatibility {
  // Semver range от рантайма AI-Cofounder, с которым скилл совместим.
  // На фазе 1 проверяем только тип (string не пуст). Полная semver-range
  // валидация подключится в Фазе 2/4, когда runtime начнёт его читать.
  runtime: string;
}

export interface Skill {
  // ── Обязательные Anthropic-совместимые поля ──
  // kebab-case, равен basename директории скилла (skills/<name>/).
  name: string;
  // Свободный текст, не пустой. Идёт в discovery layer (~80 ток/скилл).
  description: string;

  // ── Наши расширения (могут отсутствовать у «голого» Anthropic-скилла) ──
  // Semver вида `1.0.0` (^\d+\.\d+\.\d+$). Опционален: anthropic-скиллы
  // его не требуют, но наш маркетплейс — да.
  version?: string;
  category?: SkillCategory;
  // Человекочитаемое имя для UI (например, «vc.ru Publisher»).
  displayName?: string;
  // Один emoji для карточки в маркетплейсе.
  icon?: string;
  // Hex-цвет вида `#FF8800` (для UI-акцента).
  color?: string;
  // Имена других скиллов, которые должны быть загружены вместе с этим.
  // Резолвится топосортировкой в registry.resolveDeps().
  dependsOn?: string[];
  compatibleWith?: SkillCompatibility;
  // Scope'ы, нужные скиллу (например, `vc.publish`). Маппинг scope→keychain —
  // у пользователя, скилл к keychain напрямую не ходит (multi-user решение #2).
  requiresScopes?: string[];

  // ── Тело и метаданные парсинга ──
  // Markdown-тело SKILL.md (после frontmatter). Lazy injection: попадает
  // в system prompt только когда агент решил использовать скилл.
  prompt: string;
  // Абсолютный путь к директории скилла (skills/<name>/), не к SKILL.md.
  filePath: string;
  // Permissions из permissions.md. Пустой объект если файла нет.
  permissions: SkillPermissions;
}

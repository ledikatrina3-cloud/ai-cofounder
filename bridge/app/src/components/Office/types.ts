// Shared types for the Office scene.
//
// Сцена работает на live-данных: useRoutines маппит RoutineSummary → WorkerData
// (id + role + цвет + статус), live-оверлеи — из SSE-событий bridge.

export type WorkerStatus = 'idle' | 'running' | 'failed' | 'finished';

/** Какой инструмент-станция доступна в офисе. */
export type ToolStationKind = 'db' | 'fs' | 'bash' | 'web' | 'tg' | 'email';

/**
 * Минимальный shape скилла для UI (бейджи + drawer). Зеркало SkillDiscovery
 * из bridge/routines-api.ts.
 */
export interface SkillBadge {
  name: string;
  displayName?: string;
  description: string;
  icon?: string;
  color?: string;
  category?: string;
}

export interface WorkerData {
  /** routineId. Используется и как stable key, и как id для onClick. */
  id: string;
  /** Подпись над головой («Поддержка», «DB-аналитик»). */
  role: string;
  /** Опциональный emoji-аватар. Wave 2 покажет на drawer. */
  avatar?: string;
  /**
   * Путь к SVG/PNG лого (например, '/logos/vc.svg' — сервится Vite'ом из
   * bridge/app/public/). Если задан — рендерится как круглый бейдж-логотип
   * над сотрудником в офисе (приоритетнее avatar emoji).
   */
  logo?: string;
  /** Hex-цвет тела. Если undefined — будет сгенерён из id хэшем в Worker.tsx. */
  color: string;
  /** Текущий статус. Цвет точки над головой зависит от него. */
  status: WorkerStatus;
  /**
   * Если задано — воркер идёт к указанной tool-station и работает там.
   * Если undefined — стоит у своего стола (idle/bob-анимация).
   */
  walkingTo?: ToolStationKind;
  /** Сырое имя tool'а (Read/Bash/...) — для activity-карточки на станции. */
  currentToolName?: string;
  /** Tool input (filename, URL, SQL) — для краткого summary. */
  currentToolInput?: unknown;
  /** Облако мыслей: накопленный текст (≤280 chars). */
  thinking?: string;
  /** Когда мысль фейдится из облака. */
  thinkingExpiresAt?: number;
  /**
   * Резолвнутые скиллы routine'ы (Фаза 3 плана 2026-05-21-skills-architecture-v3).
   * Используются для:
   *   - цвета «футболки»: skills[0].color (primary), fallback на color.
   *   - бейджей на аватаре (до 3-х по убыванию).
   *   - списка в drawer'е.
   * Undefined / [] — у routine нет скиллов или ещё не подгружены.
   */
  skills?: SkillBadge[];
  /**
   * id отдела (departments/<id>/), к которому routine относится (Фаза 5 плана
   * 2026-05-21-skills-architecture-v3, п.3). UI использует это поле чтобы
   * сгруппировать сотрудников одного отдела в кабинет/зону. undefined —
   * routine не привязана к отделу (legacy / отдельный сотрудник).
   */
  departmentId?: string;
  /**
   * Бюджет отдела за день — pre-fetched через /departments. UI рисует
   * прогресс-полоску по dept-зоне (зелёный → жёлтый → красный) по
   * соотношению spent / perDayUsd. undefined — у отдела нет бюджета.
   */
  departmentBudget?: {
    perDayUsd: number;
    spentUsdToday: number;
  };
  /**
   * Unix ms следующего запланированного запуска. Источник — cron-расчёт от
   * routine.trigger ИЛИ одноразовая запись event.routine.scheduled-once (для
   * manual-routines, которые поставил `scripts/schedule-one-shot.ts`).
   * undefined — нет расписания и нет one-shot.
   *
   * UI использует это поле для DeskCountdown: пока status==='idle' и
   * nextRunAt в будущем — показываем «До запуска: Xм Yс» на «обратной»
   * стороне монитора сотрудника.
   */
  nextRunAt?: number;
  /**
   * Unix ms момента, когда сотрудник перешёл в status='running' (audit.routine.start).
   * Заполняется из live-events (useWorkerEvents.routine.start.ts). undefined —
   * сотрудник не работает или start-event не пришёл.
   *
   * UI использует это для DeskCountdown в режиме «работает»: показывает
   * elapsed = now - runningSince, заменяет countdown.
   */
  runningSince?: number;
  /**
   * Процент выполнения текущего workflow (0..100). Вычисляется из text-events
   * (assistant.thinking/message) regex'ом «Этап N» через useRoutineProgress.
   * Для skill article-writing это 14 крупных этапов. undefined пока
   * status≠'running'. После routine.end status='ok' = 100%.
   */
  progressPercent?: number;
  /**
   * Текстовая метка текущего этапа («6b», «13a», «12», и т.д.). undefined
   * пока ничего не распознано. Показывается рядом с прогресс-баром.
   */
  progressStageLabel?: string;
  /**
   * Сколько артефактов «сложил на стол» — это число успешных tool.end events
   * с начала текущего прогона. Растёт по мере работы. Используется для
   * визуализации стопки документов на столе (DocumentsPile). 0 — стопка
   * пустая. Сбрасывается между прогонами.
   */
  documentsCount?: number;
}

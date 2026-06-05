// Точка входа решателя для 2.5 / runIteration.
//
// Экспорт `runSolveBatch(diagnosisIds): { fanout, persist }` объединяет
// solveMany() (фаза 2.4b fan-out) и persistSolveFanout() (фаза 2.4b persist)
// в одну строку. 2.5 получит fanout (для отчёта по deferred/failures) и
// persist (для проблемных карточек по proposalsCreated[]).
//
// runIteration вызывает: const { fanout, persist } = await runSolveBatch(ids).
// Никакой собственной логики — это барреля поверх двух фаз. Тесты обоих
// шагов уже покрывают реальное поведение; e2e-тест проверяет, что обёртка
// прокидывает результаты как ожидается.

import { type SolveFanoutDeps, type SolveFanoutResult, solveMany } from './fanout.js';
import { type SolvePersistDeps, type SolvePersistResult, persistSolveFanout } from './persist.js';

export interface SolveBatchOutcome {
  fanout: SolveFanoutResult;
  persist: SolvePersistResult;
}

export interface SolveBatchDeps {
  fanoutDeps?: SolveFanoutDeps;
  persistDeps?: SolvePersistDeps;
}

export async function runSolveBatch(
  diagnosisIds: string[],
  deps: SolveBatchDeps = {},
): Promise<SolveBatchOutcome> {
  const fanout = await solveMany(diagnosisIds, deps.fanoutDeps);
  const persist = await persistSolveFanout(fanout, deps.persistDeps);
  return { fanout, persist };
}

// Re-export для удобства import'а из 2.5/тестов.
export { solveMany } from './fanout.js';
export { persistSolveFanout } from './persist.js';
export type {
  FanoutSolve,
  SolveDeferred,
  SolveFailure,
  SolveFanoutDeps,
  SolveFanoutResult,
} from './fanout.js';
export type { SolvePersistDeps, SolvePersistResult } from './persist.js';

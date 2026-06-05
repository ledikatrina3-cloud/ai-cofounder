// Фиксированный список категорий скиллов.
//
// Почему фиксированный (а не свободный текст):
//   * Учим у GPT Store, у которого 2978 productivity GPTs не findable из-за
//     overlap'ающихся категорий. См. план 2026-05-21-skills-architecture-v3,
//     раздел «Ключевые архитектурные решения», пункт 1.
//   * Маркетплейс должен дать пользователю строгую группировку: видишь
//     «publishing» — понимаешь, что внутри только публикаторы.
//   * `internal` — служебная категория для общих модулей (browser-control,
//     fs-utils). Такие скиллы скрыты от маркетплейса.

export const SKILL_CATEGORIES = [
  'publishing',
  'research',
  'writing',
  'analysis',
  'communication',
  'automation',
  'internal',
] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

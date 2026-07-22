// Org knowledge layer — слой выше проектов.
//
// План 2026-05-21-skills-architecture-v3, раздел «Ключевые архитектурные
// решения», п.2: `org/` хранит знания о самом фаундере и его продукте.
// Эти знания НЕ часть скилла (один скилл должен работать у разных юзеров с
// разными брендами) и НЕ часть проекта (проектов может быть много, бренд один).
//
// MVP — single-org: один `org/` на инсталляцию. Multi-user future:
// `users/<userId>/org/`. См. план п. «Multi-user future».
//
// 4 файла + 1 директория:
//   - identity.md          (кто мы, что делаем, для кого) — обязателен
//   - brand-voice.md       (тон, стиль, табу) — обязателен
//   - audience.md          (портреты ICP) — обязателен
//   - product-knowledge.md (фичи, отличия, цены) — опционален, не инжектится в
//                          discovery, читается через project.read когда нужно
//   - examples/            (образцовые материалы) — опционально

export interface OrgKnowledge {
  /** Body файла org/identity.md без frontmatter. */
  identity: string;
  /** Body файла org/brand-voice.md без frontmatter. */
  brandVoice: string;
  /** Body файла org/audience.md без frontmatter. */
  audience: string;
  /**
   * Body файла org/product-knowledge.md без frontmatter, или null если
   * файла нет. Этот блок не инжектируется в system prompt автоматически —
   * скилл должен его прочитать через project.read когда продуктовая
   * специфика реально нужна.
   */
  productKnowledge: string | null;
  /**
   * Абсолютный путь к директории org/examples/, или null если её нет.
   * Скиллы (например, writer) могут читать примеры через project.read.
   */
  examplesDir: string | null;
  /** Абсолютный путь к директории org/. */
  filePath: string;
}

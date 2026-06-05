// Тесты парсера черновика. Не зависят от файловой системы — DI через
// `read`-коллбек.

import { describe, expect, it } from 'vitest';
import { loadDraft, splitFrontmatter } from '../src/publish/loader.js';
import { DraftError } from '../src/publish/types.js';

function fakeRead(map: Record<string, string>): (p: string) => Promise<string> {
  return async (p: string) => {
    const v = map[p];
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  };
}

describe('publish/loader', () => {
  describe('splitFrontmatter', () => {
    it('парсит scalar и flow-array', () => {
      const md = ['---', 'title: Hello', 'tags: [a, b, c]', '---', '', 'Body line.'].join('\n');
      const fm = splitFrontmatter('/fake.md', md);
      expect(fm.scalars.get('title')).toBe('Hello');
      expect(fm.arrays.get('tags')).toEqual(['a', 'b', 'c']);
      expect(fm.body).toBe('Body line.');
    });

    it('пустой массив [] парсится в []', () => {
      const md = '---\ntags: []\ntitle: T\n---\n\nbody';
      const fm = splitFrontmatter('/f.md', md);
      expect(fm.arrays.get('tags')).toEqual([]);
    });

    it('кавычки в scalar снимаются', () => {
      const md = '---\ntitle: "Hello: World"\n---\n\nbody';
      const fm = splitFrontmatter('/f.md', md);
      expect(fm.scalars.get('title')).toBe('Hello: World');
    });

    it('кидает если frontmatter не закрыт', () => {
      const md = '---\ntitle: T\nbody without closing';
      expect(() => splitFrontmatter('/f.md', md)).toThrow(/не закрыт/);
    });

    it('без frontmatter — body это весь файл, scalars пустой', () => {
      const md = 'Просто текст без frontmatter.';
      const fm = splitFrontmatter('/f.md', md);
      expect(fm.scalars.size).toBe(0);
      expect(fm.body).toBe(md);
    });

    it('body со сложной структурой сохраняет переводы строк', () => {
      const md = ['---', 'title: T', '---', '', 'Para 1.', '', 'Para 2.'].join('\n');
      const fm = splitFrontmatter('/f.md', md);
      expect(fm.body).toBe('Para 1.\n\nPara 2.');
    });
  });

  describe('loadDraft', () => {
    it('успешно парсит валидный черновик', async () => {
      const path = '/abs/content/drafts/vc/foo.md';
      const md = [
        '---',
        'title: Заголовок',
        'status: ready',
        'tags: [ai, automation]',
        '---',
        '',
        'Тело поста.',
      ].join('\n');
      const d = await loadDraft(path, { read: fakeRead({ [path]: md }) });
      expect(d.platform).toBe('vc');
      expect(d.title).toBe('Заголовок');
      expect(d.status).toBe('ready');
      expect(d.account).toBe('main');
      expect(d.tags).toEqual(['ai', 'automation']);
      expect(d.body).toBe('Тело поста.');
      expect(d.filePath).toBe(path);
    });

    it('default status=draft, default account=main', async () => {
      const path = '/abs/content/drafts/dzen/x.md';
      const md = '---\ntitle: T\n---\n\nbody';
      const d = await loadDraft(path, { read: fakeRead({ [path]: md }) });
      expect(d.status).toBe('draft');
      expect(d.account).toBe('main');
    });

    it('кастомный account из frontmatter', async () => {
      const path = '/abs/content/drafts/reddit/x.md';
      const md = '---\ntitle: T\naccount: alt\n---\n\nbody';
      const d = await loadDraft(path, { read: fakeRead({ [path]: md }) });
      expect(d.account).toBe('alt');
      expect(d.platform).toBe('reddit');
    });

    it('кидает на отсутствие title', async () => {
      const path = '/abs/content/drafts/vc/x.md';
      const md = '---\nstatus: ready\n---\n\nbody';
      await expect(loadDraft(path, { read: fakeRead({ [path]: md }) })).rejects.toThrow(DraftError);
      await expect(loadDraft(path, { read: fakeRead({ [path]: md }) })).rejects.toThrow(/title/);
    });

    it('кидает на пустое тело', async () => {
      const path = '/abs/content/drafts/vc/x.md';
      const md = '---\ntitle: T\n---\n\n';
      await expect(loadDraft(path, { read: fakeRead({ [path]: md }) })).rejects.toThrow(/тело/);
    });

    it('кидает на неизвестный status', async () => {
      const path = '/abs/content/drafts/vc/x.md';
      const md = '---\ntitle: T\nstatus: pending\n---\n\nbody';
      await expect(loadDraft(path, { read: fakeRead({ [path]: md }) })).rejects.toThrow(/status/);
    });

    it('кидает читаемую ошибку если файл не найден', async () => {
      const path = '/abs/missing.md';
      await expect(loadDraft(path, { read: fakeRead({}) })).rejects.toThrow(DraftError);
    });

    it('platform резолвится из родительской директории', async () => {
      const path = '/abs/content/drafts/linkedin/test.md';
      const md = '---\ntitle: T\n---\n\nbody';
      const d = await loadDraft(path, { read: fakeRead({ [path]: md }) });
      expect(d.platform).toBe('linkedin');
    });
  });
});

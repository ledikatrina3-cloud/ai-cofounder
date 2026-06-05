// content-main.js - runs in world: "MAIN" на vc.ru.
//
// Имеет доступ к page closure-переменным (включая Editor.js instance) через
// React fiber walk. НЕ имеет доступа к chrome.* (общается с bridge через
// window.postMessage).
//
// Flow:
// 1. На load - найти Editor.js instance (через MutationObserver + fiber walk)
// 2. Послать READY в bridge
// 3. При PUBLISH - вызвать editor.blocks.render(), cover drag-drop, category,
//    publish click, дождаться redirect, вернуть URL.

(() => {
  const SRC = 'vc-publisher';

  /** @type {any} */
  let editor = null;
  let editorObserver = null;

  // 1. Listener: bridge -> main.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SRC || !data.from || data.from !== 'bridge') return;

    if (data.type === 'PUBLISH') {
      handlePublish(data.payload)
        .then((result) => respondToBridge(data.requestId, 'RESULT', result))
        .catch((err) => respondToBridge(data.requestId, 'ERROR', null, err.message || String(err)));
    }
  });

  function respondToBridge(requestId, type, payload, error) {
    window.postMessage({
      source: SRC,
      from: 'main',
      type,
      requestId,
      payload,
      error,
    }, '*');
  }

  function sendReady() {
    window.postMessage({
      source: SRC,
      from: 'main',
      type: 'READY',
      editorFound: editor !== null,
    }, '*');
  }

  // 2. Editor.js auto-discovery - exhaustive scan (Vue-aware).
  // vc.ru = Vue 3 (см. window.__VUE_INSTANCE_SETTERS__). Editor.js хранится в
  // setup state Vue компонента, доступен через DOM el.__vueParentComponent.ctx
  // или через ref'ы.
  function isEditorLike(v) {
    if (!v || typeof v !== 'object') return false;
    if (v.blocks && typeof v.blocks.insert === 'function') return true;
    if (v.blocks && typeof v.blocks.render === 'function') return true;
    if (typeof v.save === 'function' && v.blocks && typeof v.blocks === 'object') return true;
    if (v.api && v.api.blocks && typeof v.api.blocks.insert === 'function') return true;
    return false;
  }

  // Открыть composer (если ещё не открыт): click "Написать" или pushState.
  async function ensureComposerOpen() {
    if (document.querySelector('.modal-fullpage')) return;
    // Стратегия 1: уже на ?modal=editor URL, но модала нет - подождём.
    if (location.search.includes('modal=editor')) {
      for (let i = 0; i < 20; i++) {
        if (document.querySelector('.modal-fullpage')) return;
        await sleep(500);
      }
    }
    // Стратегия 2: click "Написать".
    const writeBtn = Array.from(document.querySelectorAll('a, button, [role="button"], div')).find(
      (el) => /^Написать$/i.test((el.textContent || '').trim()),
    );
    if (writeBtn) {
      console.log('[vc-publisher:main] clicking "Написать"');
      writeBtn.click();
      for (let i = 0; i < 30; i++) {
        if (document.querySelector('.modal-fullpage')) return;
        await sleep(500);
      }
    }
    // Стратегия 3: history.pushState fallback.
    console.log('[vc-publisher:main] fallback: history.pushState ?modal=editor');
    history.pushState({}, '', '/?modal=editor');
    window.dispatchEvent(new PopStateEvent('popstate'));
    for (let i = 0; i < 30; i++) {
      if (document.querySelector('.modal-fullpage')) return;
      await sleep(500);
    }
    throw new Error('composer modal не открылся (no "Написать" button + no pushState reaction)');
  }

  // Diagnostic POST через ISOLATED world bridge (минуя page CSP).
  async function postDiag(label, data) {
    try {
      window.postMessage(
        {
          source: SRC,
          from: 'main',
          type: 'DIAG',
          label,
          payload: { label, url: location.href, data },
        },
        '*',
      );
      // Также логируем в console на случай если bridge не отвечает.
      console.log('[vc-publisher:main] diag', label, JSON.stringify(data).slice(0, 300));
    } catch (_e) {
      // ignore
    }
  }

  function scanVueComponent(comp) {
    if (!comp || typeof comp !== 'object') return null;
    // Vue 3 component instance fields где может лежать editor:
    // - setupState (Composition API state via setup())
    // - refs (template refs)
    // - data (Options API data)
    // - ctx (component context)
    // - proxy (component proxy with all reactive state)
    const candidates = ['setupState', 'refs', 'data', 'ctx', 'proxy'];
    for (const field of candidates) {
      const obj = comp[field];
      if (!obj || typeof obj !== 'object') continue;
      // Прямые ключи объекта.
      for (const k of Object.keys(obj)) {
        try {
          const v = obj[k];
          if (isEditorLike(v)) {
            console.log('[vc-publisher:main] editor in vue comp.' + field + '.' + k);
            return v;
          }
          // Vue ref: { value: ... } или { current: ... }
          if (v?.value && isEditorLike(v.value)) {
            console.log('[vc-publisher:main] editor in vue ref ' + field + '.' + k + '.value');
            return v.value;
          }
          if (v?.current && isEditorLike(v.current)) return v.current;
        } catch (_e) {
          // ignore reactive proxy traps
        }
      }
    }
    return null;
  }

  function snapshotPageState() {
    const w = window;
    const winKeysWithBlocks = [];
    for (const key of Object.getOwnPropertyNames(w)) {
      try {
        const v = w[key];
        if (v && typeof v === 'object') {
          if (v.blocks || v.save || v.api?.blocks) {
            winKeysWithBlocks.push({
              key,
              hasBlocks: !!v.blocks,
              hasSave: typeof v.save === 'function',
              hasApiBlocks: !!v.api?.blocks,
              blocksKeys: v.blocks ? Object.keys(v.blocks).slice(0, 10) : null,
              ctor: v.constructor?.name,
            });
          }
        }
      } catch (_e) {
        // ignore cross-origin / getters
      }
    }
    // Подсчёт Vue components на странице.
    let vueCompCount = 0;
    const vueSamples = [];
    for (const el of document.querySelectorAll('*')) {
      const c = el.__vueParentComponent;
      if (c) {
        vueCompCount++;
        if (vueSamples.length < 5) {
          vueSamples.push({
            tag: el.tagName,
            cls: (el.className || '').toString().slice(0, 80),
            setupKeys: c.setupState ? Object.keys(c.setupState).slice(0, 8) : null,
            refsKeys: c.refs ? Object.keys(c.refs).slice(0, 8) : null,
          });
        }
      }
    }
    return {
      contenteditableCount: document.querySelectorAll('[contenteditable="true"]').length,
      codexEditorEls: document.querySelectorAll('.codex-editor').length,
      ceBlockEls: document.querySelectorAll('.ce-block').length,
      editorToolInputEls: document.querySelectorAll('.editor-tool-input').length,
      modalFullpage: !!document.querySelector('.modal-fullpage'),
      vueCompCount,
      vueSamples,
      winKeysWithBlocks,
    };
  }

  function findEditorJsInstance() {
    // Strategy A: window globals (vc.ru может expose под разными именами).
    const w = window;
    const winKeys = Object.getOwnPropertyNames(w);
    for (const key of winKeys) {
      try {
        const v = w[key];
        if (isEditorLike(v)) {
          console.log('[vc-publisher:main] found editor on window.' + key);
          return v;
        }
      } catch (_e) {
        // защита от cross-origin / getters
      }
    }

    // Strategy A.5: Vue 3 component walk - vc.ru использует Vue 3.
    // Editor.js хранится в setupState/refs/data Vue component'а.
    const allEls = document.querySelectorAll('*');
    const visitedVueComps = new Set();
    for (const el of allEls) {
      const vueComp = el.__vueParentComponent;
      if (vueComp && !visitedVueComps.has(vueComp)) {
        visitedVueComps.add(vueComp);
        const found = scanVueComponent(vueComp);
        if (found) return found;
      }
    }

    // Strategy B: scan ВСЕХ DOM-элементов с React fiber keys.
    // Не привязываемся к конкретному селектору - просто берём первый fiber root
    // и walk'аем все ветви.
    const all = document.querySelectorAll('*');
    const visited = new Set();
    for (const el of all) {
      const keys = Object.keys(el);
      const fiberKey = keys.find(
        (k) =>
          k.startsWith('__reactFiber') ||
          k.startsWith('__reactInternalInstance') ||
          k.startsWith('__reactProps'),
      );
      if (!fiberKey) continue;

      let fiber = el[fiberKey];
      // Иногда __reactProps содержит ref на текущий fiber через props.
      if (fiberKey.startsWith('__reactProps')) {
        // Попытаемся найти sibling __reactFiber у того же элемента.
        const altKey = keys.find((k) => k.startsWith('__reactFiber'));
        if (altKey) fiber = el[altKey];
      }

      // Walk вверх (return chain) + проверка children через fiber.child.
      while (fiber && !visited.has(fiber)) {
        visited.add(fiber);

        // 1) stateNode
        const node = fiber.stateNode;
        if (node && typeof node === 'object' && !(node instanceof Element)) {
          if (isEditorLike(node)) {
            console.log('[vc-publisher:main] editor in stateNode of', fiber.type?.displayName || fiber.type?.name || 'unknown');
            return node;
          }
          for (const k of Object.keys(node)) {
            try {
              const v = node[k];
              if (isEditorLike(v)) {
                console.log('[vc-publisher:main] editor in stateNode.' + k);
                return v;
              }
              if (v?.current && isEditorLike(v.current)) {
                console.log('[vc-publisher:main] editor in stateNode.' + k + '.current');
                return v.current;
              }
            } catch (_e) {
              // ignore
            }
          }
        }

        // 2) memoizedProps - все ключи.
        if (fiber.memoizedProps && typeof fiber.memoizedProps === 'object') {
          for (const k of Object.keys(fiber.memoizedProps)) {
            try {
              const v = fiber.memoizedProps[k];
              if (isEditorLike(v)) {
                console.log('[vc-publisher:main] editor in memoizedProps.' + k);
                return v;
              }
              if (v?.current && isEditorLike(v.current)) return v.current;
            } catch (_e) {
              // ignore
            }
          }
        }

        // 3) memoizedState - hook chain.
        if (fiber.memoizedState) {
          let state = fiber.memoizedState;
          for (let j = 0; j < 30 && state; j++) {
            const mem = state.memoizedState;
            if (isEditorLike(mem)) {
              console.log('[vc-publisher:main] editor in memoizedState.memoizedState');
              return mem;
            }
            if (mem?.current && isEditorLike(mem.current)) return mem.current;
            // Иногда useRef держит editor в .current через несколько уровней.
            if (mem && typeof mem === 'object') {
              for (const k of Object.keys(mem)) {
                try {
                  const v = mem[k];
                  if (isEditorLike(v)) return v;
                  if (v?.current && isEditorLike(v.current)) return v.current;
                } catch (_e) {
                  // ignore
                }
              }
            }
            state = state.next;
          }
        }

        fiber = fiber.return;
      }
    }

    return null;
  }

  function tryFindEditor() {
    const found = findEditorJsInstance();
    if (found !== null) {
      editor = found;
      console.log('[vc-publisher:main] editor.js instance found:', editor);
      sendReady();
      if (editorObserver !== null) {
        editorObserver.disconnect();
        editorObserver = null;
      }
      // Привязываем к window для отладки в DevTools.
      try {
        /** @type {any} */
        const w = window;
        w.__vcPublisherEditor = editor;
      } catch (_e) {
        // ignore
      }
    }
  }

  // Initial probe.
  tryFindEditor();

  // Подписка на изменения DOM (composer открывается dynamically).
  if (editor === null) {
    editorObserver = new MutationObserver(() => tryFindEditor());
    editorObserver.observe(document.body, { childList: true, subtree: true });
  }

  // Если composer ещё не открыт, отправляем READY с editorFound=false - bridge
  // продолжит ждать. Можем послать после небольшой задержки.
  setTimeout(() => sendReady(), 500);

  /**
   * @param {{ title: string, blocks: object[], cover: string|null, category: string|null, tags: string[] }} payload
   */
  async function handlePublish(payload) {
    console.log('[vc-publisher:main] PUBLISH received, blocks:', payload.blocks?.length);
    console.log('[vc-publisher:main] location:', location.href);

    // Перед поиском editor - убедиться что composer вообще открыт.
    await ensureComposerOpen();
    console.log('[vc-publisher:main] composer modal open, searching editor...');
    // Дать Editor.js дополнительное время на init после открытия модала.
    await sleep(2000);
    tryFindEditor();

    // Если editor ещё не найден, подождать + retry.
    if (editor === null) {
      console.log('[vc-publisher:main] editor not found yet, waiting up to 60s...');
      // Initial diagnostic snapshot.
      postDiag('publish-start', snapshotPageState());

      for (let i = 0; i < 120; i++) {
        await sleep(500);
        // Каждые 5 сек делаем повторный probe + diagnostic snapshot.
        if (i % 10 === 0 && i > 0) {
          tryFindEditor();
          if (editor === null) {
            postDiag(`probe-wait-${i / 2}s`, snapshotPageState());
          }
        }
        if (editor !== null) break;
      }
      if (editor === null) {
        // Diagnostic dump перед throw - чтобы было видно что на странице.
        const dump = {
          location: location.href,
          modalFullpage: !!document.querySelector('.modal-fullpage'),
          editorToolInputCount: document.querySelectorAll('.editor-tool-input').length,
          contenteditableCount: document.querySelectorAll('[contenteditable="true"]').length,
          contenteditableEls: Array.from(
            document.querySelectorAll('[contenteditable="true"]'),
          ).map((el) => ({
            tag: el.tagName,
            className: el.className,
            id: el.id,
            reactKeys: Object.keys(el).filter((k) => k.startsWith('__react')),
          })),
          windowEditorKeys: Object.getOwnPropertyNames(window).filter((k) =>
            /editor|cdx|ce_/i.test(k),
          ),
        };
        console.error('[vc-publisher:main] EDITOR NOT FOUND. dump:', dump);
        throw new Error(
          'Editor.js instance not found after 60s. Diagnostic: ' + JSON.stringify(dump),
        );
      }
    }

    // Title идёт как первый header level=1 в блоках (vc.ru title = первый H1).
    const blocksWithTitle = [
      { type: 'header', data: { text: escapeForBlock(payload.title), level: 1 } },
      ...payload.blocks,
    ];

    console.log('[vc-publisher:main] calling editor.blocks.render with', blocksWithTitle.length, 'blocks');
    await editor.blocks.render({ blocks: blocksWithTitle });
    await sleep(800);

    // Cover upload через drag-drop (если cover_data_url передан как base64).
    if (payload.cover) {
      console.log('[vc-publisher:main] uploading cover...');
      await uploadCover(payload.cover);
    }

    // Category - click через UI.
    if (payload.category) {
      console.log('[vc-publisher:main] selecting category', payload.category);
      await selectCategory(payload.category);
    }

    // Wait autosave.
    await waitForAutosave();
    console.log('[vc-publisher:main] autosaved, clicking publish');

    // Click publish.
    const btn = findPublishButton();
    if (!btn) throw new Error('publish button not found');
    btn.click();

    // Wait for redirect.
    const url = await waitForPublishUrl();
    console.log('[vc-publisher:main] published at:', url);
    return { url };
  }

  function escapeForBlock(text) {
    return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function uploadCover(dataUrl) {
    const blob = await fetch(dataUrl).then((r) => r.blob());
    const file = new File([blob], 'cover.png', { type: blob.type || 'image/png' });

    const editorEl = document.querySelector('.editor-tool-input[contenteditable="true"]');
    if (!editorEl) throw new Error('editor element not found for cover');

    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    editorEl.dispatchEvent(ev);

    // Ждём CDN HTTPS URL (не blob://).
    for (let i = 0; i < 60; i++) {
      const img = document.querySelector('.modal-fullpage img, .editor img');
      const src = img?.getAttribute('src') ?? '';
      if (src.startsWith('https://') && !src.includes('blob:')) {
        console.log('[vc-publisher:main] cover at CDN:', src);
        return;
      }
      await sleep(1000);
    }
    throw new Error('cover CDN upload timeout (60s)');
  }

  async function selectCategory(category) {
    const labelByCategory = {
      ai: /^Искусственный интеллект$|^AI$/i,
      'lichnyy-opyt': /^Личный опыт$/i,
      future: /^Будущее$|^Тренды$/i,
      business: /^Бизнес$/i,
      tech: /^Технологии$|^Tech$/i,
    };
    const label = labelByCategory[category];
    if (!label) throw new Error(`unknown category: ${category}`);

    const modal = document.querySelector('.modal-fullpage');
    if (!modal) throw new Error('modal-fullpage not found');

    const opener = Array.from(modal.querySelectorAll('div, span, a, button')).find(
      (e) => /^Без темы$/i.test((e.textContent || '').trim()),
    );
    if (!opener) throw new Error('"Без темы" opener not found');
    /** @type {any} */(opener).click();
    await sleep(1200);

    const options = Array.from(document.querySelectorAll('.context-list-option'));
    const item = options.find((o) => label.test((o.textContent || '').trim()));
    if (!item) {
      const all = options.map((o) => (o.textContent || '').trim());
      throw new Error(`category "${category}" not found in dropdown, available: ${all.join(', ')}`);
    }
    /** @type {any} */(item).click();
    await sleep(500);
  }

  async function waitForAutosave() {
    for (let i = 0; i < 30; i++) {
      const modal = document.querySelector('.modal-fullpage');
      if (modal && /Сохранено/i.test(modal.textContent || '')) return;
      await sleep(500);
    }
  }

  function findPublishButton() {
    const btns = Array.from(document.querySelectorAll('button.button--type-primary.button--rounded, button'));
    return btns.find((b) => /^Опубликовать$/i.test((b.textContent || '').trim())) ?? null;
  }

  async function waitForPublishUrl() {
    const startUrl = location.href;
    for (let i = 0; i < 90; i++) {
      const url = location.href;
      // Успех: URL изменился И не содержит /new/editor/modal=editor.
      if (
        url !== startUrl &&
        !/(write|editor|new|modal=editor)/.test(url) &&
        /vc\.ru\/(\w+\/)?\d+/.test(url)
      ) {
        return url;
      }
      await sleep(1000);
    }
    throw new Error('publish redirect timeout (90s)');
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  console.log('[vc-publisher:main] loaded');
})();

---
name: docker-cyrillic-fonts
description: Docker-контейнеры на nixpacks/alpine/ubuntu по default не имеют шрифтов. Если код рендерит русский текст через sharp/librsvg/canvas — добавь apt-packages.
type: feedback
---

Если в проекте есть рендеринг русского/кириллического текста через
sharp+SVG, libvips, node-canvas, puppeteer-screenshot — Docker-образ
ОБЯЗАТЕЛЬНО должен иметь системные шрифты с Cyrillic-glyphs.
Иначе librsvg fallback'нется на embedded font без Cyrillic и выпустит
tofu-боксы (□).

**Why:** прецедент с hero-pipeline (генерация обложек). Прод-контейнер
Ubuntu 24.04 nixpacks default — `fc-list | wc -l` → 0. Любой
`<text font-family="DejaVu Sans">русский</text>` в SVG → librsvg
silently fallback'нется → tofu-боксы. 12 из 14 hero-обложек оказались
с tofu-headline'ами, провели в проде 2 недели.

Особенно коварно потому что:
- macOS dev-машина имеет шрифты системно → smoke-test проходит
- librsvg не бросает ошибку — просто рендерит tofu
- contrast-gate не ловит (тофу-боксы тёмные на тёмном)
- visual-ranker оценивает illustration, не overlay-композицию

**How to apply:**

В `nixpacks.toml`:
```toml
[phases.setup]
aptPkgs = ["fontconfig", "fonts-dejavu-core", "fonts-liberation", "fonts-noto-core"]
```

В Dockerfile (Debian/Ubuntu base):
```dockerfile
RUN apt-get update && apt-get install -y \
    fontconfig fonts-dejavu-core fonts-liberation fonts-noto-core \
    && fc-cache -f && rm -rf /var/lib/apt/lists/*
```

В Dockerfile (Alpine base):
```dockerfile
RUN apk add --no-cache fontconfig ttf-dejavu ttf-liberation
```

**Sanity-check после деплоя** (один раз для каждого нового image):
```bash
docker exec <container> sh -c "fc-list :lang=ru | wc -l"
# Должно вернуть число > 0 (обычно 30-50 шрифтов покрывают Cyrillic).
```

Если в проекте есть автоматическая генерация изображений с русским
текстом — добавить smoke-test в CI: рендер тест-cover → tessera/Vision-OCR
→ assert что русские символы распознаны.

#!/usr/bin/env bash
# update-engine.sh — обновить ДВИЖОК AI-Cofounder из upstream, не трогая
# пользовательский слой (agents/ org/ ai-clone/ config/* .env ...).
#
# Механизм: upstream не поставляет файлов по user-путям (они в .gitignore),
# поэтому тянуть «всё» нечего — мы прицельно применяем ТОЛЬКО engine[]-пути из
# engine-manifest.json (adds + modifies + DELETES). См. docs/UPDATING.md.
#
# Требует: настроенный remote `upstream` (git remote add upstream <URL>),
# чистое рабочее дерево по engine-путям.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "Нет remote 'upstream'. Сначала: git remote add upstream <URL>" >&2
  exit 1
fi

BRANCH="${1:-main}"
echo "==> git fetch upstream"
git fetch upstream "$BRANCH"

# Engine-пути из манифеста (node — всегда есть в стеке, в отличие от jq).
# bash-3.2-safe (macOS /bin/bash — основная ОС проекта — без `mapfile`).
ENGINE_PATHS=()
while IFS= read -r p; do
  [ -n "$p" ] && ENGINE_PATHS+=("$p")
done < <(node -e "for (const p of require('./engine-manifest.json').engine) console.log(p)")

PRE_UPDATE_HEAD="$(git rev-parse HEAD)"

# Гард чистого дерева: апдейт делает `git checkout upstream -- <path>`, который
# МОЛЧА затирает локальные правки engine-файлов. Останавливаемся, если по
# engine-путям есть незакоммиченное (user-слой вне проверки — он gitignored).
# FORCE=1 — осознанно проигнорировать (правки engine-файлов будут потеряны).
if ! git diff-index --quiet HEAD -- "${ENGINE_PATHS[@]}"; then
  echo "Есть незакоммиченные изменения по engine-путям — апдейт их затрёт:" >&2
  git diff-index --name-only HEAD -- "${ENGINE_PATHS[@]}" | sed 's/^/  /' >&2
  if [ "${FORCE:-}" != "1" ]; then
    echo "Закоммить/застешь их, либо запусти с FORCE=1, если готов потерять." >&2
    exit 1
  fi
  echo "FORCE=1 — продолжаю, локальные правки engine-файлов будут потеряны." >&2
fi

# Откат при падении гейта: diff применяется ДО build/test, поэтому красный гейт
# оставлял бы движок полу-применённым. На ошибке откатываем engine-файлы к
# PRE_UPDATE_HEAD (user-слой не трогаем — он untracked/gitignored).
APPLIED=0
rollback_on_fail() {
  trap - ERR EXIT
  [ "$APPLIED" = "1" ] || exit 1
  echo "" >&2
  echo "!! Сбой после применения diff'а — откатываю движок к ${PRE_UPDATE_HEAD}." >&2
  git reset -q --hard "$PRE_UPDATE_HEAD" >/dev/null 2>&1 || true
  git clean -fdq -- "${ENGINE_PATHS[@]}" >/dev/null 2>&1 || true
  echo "   Откат сделан. Почини причину (build/test) и запусти pnpm update-engine заново." >&2
  exit 1
}
trap rollback_on_fail ERR

echo "==> diff engine-путей: HEAD против upstream/$BRANCH"
# ВАЖНО: source = HEAD (наш локальный движок), target = upstream. Тогда A|M|R —
# то, что upstream ДОБАВИЛ/ИЗМЕНИЛ/переименовал относительно нас (применяем из
# upstream), а D — что upstream УДАЛИЛ (удаляем локально). Без явного HEAD
# `git diff upstream` сравнивал бы upstream→рабочее-дерево и инвертировал все
# буквы (A↔D), из-за чего скрипт удалял бы новые upstream-файлы и падал на
# upstream-удалениях.
CHANGES="$(git diff --name-status HEAD "upstream/$BRANCH" -- "${ENGINE_PATHS[@]}" || true)"

if [ -z "$CHANGES" ]; then
  echo "Движок уже актуален — изменений по engine-путям нет."
else
  APPLIED=1
  echo "$CHANGES"
  while IFS=$'\t' read -r status path rest; do
    [ -z "${status:-}" ] && continue
    case "$status" in
      D)
        echo "  - удаляю (upstream удалил): $path"
        git rm -q --ignore-unmatch -- "$path" || rm -f -- "$path"
        ;;
      R*)
        # rename: rest = новый путь. Применяем новый, удаляем старый.
        echo "  - переименование: $path -> ${rest:-?}"
        [ -n "${rest:-}" ] && git checkout "upstream/$BRANCH" -- "$rest"
        git rm -q --ignore-unmatch -- "$path" || true
        ;;
      *)
        echo "  - обновляю: $path"
        git checkout "upstream/$BRANCH" -- "$path"
        ;;
    esac
  done <<< "$CHANGES"
fi

# UPDATE_ENGINE_SKIP_GATE=1 пропускает install/migrate/build/test-хвост —
# используется тестом tests/engine/update-engine.test.ts, который проверяет
# ТОЛЬКО корректность применения diff'а (А/M/D/R + неприкосновенность user-слоя).
if [ "${UPDATE_ENGINE_SKIP_GATE:-}" = "1" ]; then
  echo "==> UPDATE_ENGINE_SKIP_GATE=1 — пропускаю install/migrate/build/test."
else
  echo "==> pnpm install (lockfile — engine-owned)"
  pnpm install

  echo "==> pnpm migrate (schema БД + миграции пользовательского слоя)"
  pnpm db:migrate
  pnpm migrate

  echo "==> gate: pnpm build && pnpm test"
  pnpm build
  pnpm test
fi

echo "==> Готово. Пользовательский слой (agents/ org/ ai-clone/ config/* .env) не тронут."
echo "    Проверь git status — там должны быть только engine-файлы."

# Редактор карт — DXF, LIF, веб-редакторы, горячая замена

Дата: 2026-08-11. Лицензионный гейт: MIT/Apache/BSD/EPL/ISC. Все лицензии проверены по репозиториям/npm registry (не по README).

## TL;DR

Готового не-GPL веб-редактора складских карт **не существует** — подтверждённая дыра рынка (как и с оркестратором). Сборка из проверенных MIT-кусков дешёвая: `dxf-parser` (MIT) для импорта CAD-подложки, `vdma-lif` (MIT, официальные JSON-схемы VDMA) как нативный формат хранения, доменная модель из openTCS (идеи), рендер — уже имеющийся Pixi из @tez/dashboard. Редактор = вкладка дашборда + пакет `@tez/map-editor`. Оценка: **10–14 dev-дней**, 3 независимые фазы.

## 1. DXF-парсеры для JS/TS

| Пакет | Лицензия (проверена) | Состояние | Вердикт |
|---|---|---|---|
| `dxf-parser` (gdsestimating) | **MIT** (npm 1.1.2) | 554★, TS; `lwpolyline/polyline/line/arc/circle/insert/text/spline`; слои поддержаны. Publish 2022 — DXF заморожен, не риск | **ВЗЯТЬ** — основной |
| `dxf` (bjnortier) | **MIT** (npm 5.3.1, сен 2025) | 401★, активнее; денормализация блоков (INSERT с трансформами), конверсия в полилинии | **Запасной** — если нужна денормализация/SVG-превью |
| `three-dxf` | **MIT** | тянет three.js — у нас Pixi | Пропустить |
| `dxf-viewer` (vagran) | **MPL-2.0** | Технически лучший вьювер (WebGL, воркеры) | **ПРОПУСТИТЬ — MPL-2.0 не в гейте.** Зафиксировано как соблазн-ловушка |
| `@tarikjabiri/dxf` | **MIT** | DXF-**писатель** | Опция на будущее (экспорт в CAD), не в скоуп |

**Решение:** DXF — только **подложка + источник геометрии** (стены, стеллажи, колонны), не формат карты. Пайплайн: `dxf-parser` → фильтр по слоям (чекбоксы) → полилинии/отрезки → Pixi-фон + автогенерация запретных зон по замкнутым полилиниям (стретч, фаза 2). Масштаб/origin — калибровка «кликни две точки, введи расстояние» (`$INSUNITS` бывает мусорным).

## 2. Open-source веб-редакторы — пригодных не-GPL НЕТ

- **`open-rmf/rmf_traffic_editor`** — Apache-2.0, но desktop **Qt/C++**. Только идеи UX: вершины/полосы поверх подложки-плана, этажи, направленность полос.
- **`open-rmf/rmf_site`** — преемник, Apache-2.0, Rust+Bevy с WASM, но «experimental», у веб-версии нет сохранения/загрузки. Пропустить, наблюдать.
- **`bekirbostanci/vda5050_lif_editor`** — GPL-3, **ЗАПРЕЩЕНО**. Существенно: сам факт его существования доказывает, что LIF-редактор — небольшой проект (один человек на Vue). **Чистая комната: не открывать его код**; идеи — из LIF-спеки.
- **`react-flow` / xyflow** — MIT (38k★; Pro = платные примеры, не лицензионное ограничение). Но это редактор **блок-схем**: px-координаты, нет метрики, полигональных зон, подложки. Останется только drag-n-drop-обвязка, которая у Pixi есть (pixi-viewport в стеке). Пропустить.
- Konva/Leaflet/GeoJSON — гео-домен (WGS84, тайлы). Пропустить.

**Вердикт: редактор пишем сами на имеющемся стеке Pixi+React+zustand.** Рендер карты, viewport, сетка, модель графа уже существуют в @tez/dashboard — редактор добавляет режимы взаимодействия и панель свойств.

## 3. LIF как нативный формат

Спецификация: VDMA Guideline **v1.0.0, март 2024** (PDF: vdma.eu `FuI_Guideline_LIF_GB.pdf`; разработан VDMA+VDA под VDA 5050).

- JSON. `metaInformation` (`projectIdentification`, `creator`, `exportTimestamp`, `lifVersion`) → `layouts[]` (`layoutId`, `layoutLevelId` — мультиэтаж!) → `nodes[]` (`nodeId`, `nodePosition{x,y}`, `mapId`, `vehicleTypeNodeProperties[]`) + `edges[]` (`vehicleTypeEdgeProperties[]`: `vehicleOrientation`, `orientationType`, `rotationAllowed`, `maxSpeed`, `maxRotationSpeed`, `maxHeight/minHeight`, `loadRestriction`, `trajectory` NURBS) + `stations[]` (`stationId`, `interactionNodeIds`, `stationPosition`).
- Терминология 1:1 с VDA 5050 (`nodeId`/`edgeId`/`mapId` едут прямо в order) — конверсия карта→order тривиальна.
- **`continua-systems/vdma-lif`** — MIT, официозные JSON-схемы + кодогенерённые модели, **npm `vdma-lif` 1.0.0-7 (дек 2025)**, есть Python/C#. Репо маленькое (8★), но это схема+типы; валидация через ajv (в стеке).

**Вердикт: LIF брать как нативный формат, с одним слоем расширения.** LIF не покрывает: зоны трафика, зарядные политики, DXF-подложку, блоки. Решение: **LIF + `tezExtensions`** (сайдкар: зоны, станции зарядки, подложка, блоки). Экспорт «чистого LIF» = отбросить расширения. Даёт: (а) интероп-историю для тендеров («мы читаем/пишем VDMA LIF»), (б) миграцию grid→LIF генератором, (в) готовые типы из npm.

## 4. openTCS Model Editor — идеи для доменной модели (MIT, код Java/Swing не трогаем)

- **Point** с типом: `Halt position` vs `Park position` — фундамент парковки/зарядки (дыра №1). Координаты + ориентация в точке.
- **Path**: length, maxVelocity + **maxReverseVelocity**, **`locked` flag** — дешёвое оперативное перекрытие проходов. Peripheral operations на пути (дверь при проезде) — стык с дырой №4.
- **Location type** (разрешённые операции) отдельно от **Location** (привязана к точкам через **Links**, свой `locked`) — правильная нормализация станций; LIF-`stations` ложатся 1:1.
- **Block**: набор ресурсов + `Single vehicle only` / `Same direction only` — семантика для зон (дыра №2). Редактор должен рисовать блоки выделением.
- **Layers + layer groups**: active/visible, группы = этажи (дыра №5). Дёшево в Pixi (контейнеры).
- **Vehicle envelopes** — в backlog библиотеки моделей (дыра №9).
- UX-паттерн: Model Editor — **отдельное приложение** от Operations Desk; редактирование офлайн, потом явный «Upload model to kernel».

## 5. Горячая замена карты без рестарта

openTCS: **никак толком** — «Upload model to kernel» replaced модель, заказы сносятся. Наш шанс сделать лучше.

VDA 5050 (main): map-lifecycle стандартизован — `maps[]` в state (`mapId`+`mapVersion`+`mapStatus` ENABLED/DISABLED), instant actions **`downloadMap`** (`mapDownloadLink`, `mapHash`), **`enableMap`**, **`deleteMap`**; ошибки `UNKNOWN_MAP_ID`, `DUPLICATE_MAP`. Наш дизайн «версионированная карта у оркестратора» = ровно куда пришёл стандарт; схема версий совпадает со спековской.

Дизайн:
1. **MapVersion first-class**: `mapId` + монотонный `mapVersion`, карта иммутабельна после активации; в @tez/persistence.
2. **Двухфазная активация** (blue-green): загрузили v2 → валидация (связность, orphan-станции, роботы на существующих узлах) → `activate`.
3. **Drain-стратегии**:
   - **v1 (в скоуп): graceful drain** — новые заказы по v2 только когда флот «сошёл с разницы»: заказы в полёте доезжают по v1, PIBT-окно и резервации на v1 до опустошения, потом атомарный свап.
   - **v2 (потом): diff-активация** — diff не задевает занятые/зарезервированные клетки → мгновенный свап; иначе fallback на graceful. Structural diff по nodeId/edgeId тривиален.
   - Миграцию резерваций «на лету» — **не делать** (research-уровень); drain покрывает 95%.
4. **API-хуки**: `POST /maps` (draft), `POST /maps/:id/validate`, `POST /maps/:id/activate`, WS-событие `map.activated{mapId,mapVersion}` — дашборд перезагружает сцену без рефреша. Записать в PLAN2-HOOK-REQUESTS.md.
5. Роботы на удалённом узле после свапа → статус `LOST` + перегон к ближайшему узлу v2.

## Эскиз дизайна

- **Пакет `@tez/map-editor`**: доменная модель (LIF-типы из `vdma-lif` + tezExtensions), команды редактирования (undo/redo как command stack), DXF-импорт-пайплайн, валидатор. Без React — чистый TS, тестируемый.
- **Вкладка «Editor» в @tez/dashboard**: тот же Pixi-рендерер в режиме edit; инструменты: select / add node / add edge (drag-цепочка) / draw zone (полигон) / place station / block-выделение; панель свойств; слои и DXF-подложка с opacity; snap к сетке и DXF-вершинам.
- **Поток**: редактор работает над draft-картой; сохранение = новый `mapVersion` draft, активация — см. §5. Разделение edit/operate — из openTCS UX.
- Программный grid остаётся: `gridToLif()` — все существующие тесты живут поверх LIF-модели.

## Трудоёмкость (сильный dev + ИИ)

| Фаза | Дни |
|---|---|
| A: LIF-модель + tezExtensions + gridToLif + валидатор + миграция оркестратора на LIF-модель | 2–3 |
| B: горячая замена (версии, validate/activate API, graceful drain, WS-событие, перезагрузка сцены) | 2–3 |
| C: редактор-вкладка (Pixi-режимы, инструменты, панель свойств, undo/redo, слои) | 4–5 |
| D: DXF-импорт (dxf-parser, слои, калибровка, подложка; автозоны — стретч) | 2–3 |
| **Итого** | **10–14** |

A+B самодостаточны и ценны без редактора (закрывают «рестарт при смене карты»); C и D режутся по времени. Фаза A (Point types HALT/PARK, Location/станции) — прямой фундамент для зарядки → поднять в приоритете.

## Риски

1. **MPL-соблазн**: dxf-viewer технически лучший — в гейт не входит; зафиксировано, чтобы будущая сессия не втащила.
2. **Чистая комната от GPL lif_editor**: не читать его код, работать от PDF-спеки и JSON-схем vdma-lif (MIT).
3. **Грязные DXF**: proxy-объекты, кривые юниты, блоки в блоках — dxf-parser часть молча пропускает. Митигация: импорт только выбранных слоёв, «best effort»-подложка, калибровка по двум точкам обязательна; `dxf` (bjnortier) как запасной денормализатор.
4. **vdma-lif — маленькое репо**: риск заброшенности. Митигация: схемы+типы, вендорим (MIT позволяет); контракт — сам PDF-стандарт.
5. **LIF 1.0 не покрывает зоны/зарядку** — расширения в отдельном namespace, «экспорт чистого LIF» всегда работает (важно для маркетинга).
6. **Drain на живом складе** длится минуты — UI-статус «map v2 pending, N роботов на старой версии», иначе оператор решит, что зависло.
7. **Конфликт правок**: v1 — пессимистичная блокировка draft (один редактор за раз), CRDT не нужен.

Источники: github.com/gdsestimating/dxf-parser, github.com/bjnortier/dxf, github.com/vagran/dxf-viewer (MPL), github.com/continua-systems/vdma-lif + npm `vdma-lif`, github.com/xyflow/xyflow, github.com/open-rmf/rmf_traffic_editor, github.com/open-rmf/rmf_site, vdma.eu FuI_Guideline_LIF_GB.pdf (v1.0.0 03/2024), opentcs.org/docs/6/user (6.7), github.com/VDA5050/VDA5050 (main).

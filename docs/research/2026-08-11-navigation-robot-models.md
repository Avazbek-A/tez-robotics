# Свободная/гибридная навигация + Библиотека моделей роботов

Дата: 2026-08-11. Контекст: PIBT-роутер на регулярной сетке + ReservationTable (`packages/core/src/reservations.ts`), VDA5050 через `vda-5050-lib@1.7.2` (проверено локально), целевые склады — стеллажные (UZ/RU/KZ). Все доноры MIT/Apache/спецификации.

## TL;DR

| Тема | Вердикт | Дни |
|---|---|---|
| A. Свободная навигация как режим роутинга | **ПРОПУСТИТЬ** | 0 |
| A′. Минимальный гибрид: NURBS-`trajectory` на рёбрах | **ОТЛОЖИТЬ** до физического робота; шов заложить сейчас | 0 сейчас; 3–5 потом |
| B. Библиотека моделей роботов | **СТРОИТЬ**: обернуть VDA5050 factsheet + идеи openTCS/Open-RMF | 5–7 |

---

## Тема A: свободная/гибридная навигация

### A1. Как это делает SEER RDS

- Навигация **двухслойная**: RDS маршрутизирует по **сети путей (路网)**, нарисованной в Roboshop — граф из отрезков и кривых Безье; «свободная навигация» (SLAM по natural features) — способ **локализации**, не маршрутизации. Робот едет по нарисованным путям. Безье SEER рекламирует для паллетных роботов как **уплотнение пространства** (плавный поворот в узком проходе без остановки и разворота на месте) — seer-robotics.ai/blog/pallet-jack-robots.
- **Docking** (зарядка, подныривание под стеллаж, конвейер) — не свободная навигация оркестратора, а **бортовая функция контроллера SRC**: точный подъезд по QR/отражателям/V-метке ±2 мм. Оркестратор посылает робота на узел «перед станцией» и командует action.
- **Обход препятствий** — бортовой: робот тормозит/объезжает в коридоре пути; оркестратор в лучшем случае перестраивает маршрут по графу.
- Вывод: даже флагманский коммерческий оркестратор на стеллажном складе **маршрутизирует по графу**. Кривизна — свойство рёбер, не пространства поиска.

### A2. VDA5050 trajectory (NURBS)

По локальным типам `vda-5050-lib` (`common/vda-5050-types-2.0.d.ts`):
- `Edge.trajectory?: Trajectory` — опциональный NURBS: `controlPoints: {x, y, weight?, orientation?}[]`, `degree`, `knotVector`.
- Поле **опционально**: «can be omitted if AGV cannot process trajectories or if AGV plans its own trajectory». Поддержка декларируется в factsheet → `protocolFeatures.optionalParameters`.
- **Реальная поддержка у роботов — редкость.** Стандарт делает поле опциональным именно потому, что большинство AMR планируют траекторию бортом (обзор arXiv:2311.14615). `VirtualAgvAdapter` (наш sim) **игнорирует trajectory** — движется узел-к-узлу линейно (проверено в `adapter/virtual-agv-adapter.d.ts`). Даже если начнём слать NURBS, свой симулятор их не исполнит без доработки.
- Практический смысл на стеллажном складе один: **скругление углов** для diff/ackermann-кинематики. Для omni — около нуля.

### A3. openTCS: кривые в модели, роутинг по графу

`Path` в Model Editor может быть Bezier/Bezier-3, но это **геометрия ребра** — роутинг остаётся по `source/destination/cost` (Dijkstra). Кривая уходит в comm-adapter как форма исполнения. openTCS за 20+ лет полевой эксплуатации **ни разу не добавил не-графовый роутинг** — сильнейший внешний аргумент.

### A4. Рекомендация

**Пропустить свободную навигацию как режим роутинга. Целиком.**
1. Стеллажный склад — регулярная сетка по определению. PIBT на сетке даёт масштабирование на 100+ роботов; свободные планировщики (CCBS и пр., research-лицензии) — нет.
2. Все три референса сходятся: **оркестратор владеет топологией и порядком, робот — геометрией и стыковкой**. Docking/обход — бортовые; нам достаточно узла «pre-dock» + VDA5050 action.
3. Продать нельзя: клиент видит «роботы едут и не сталкиваются», не форму кривой.

**Минимальный гибрид (отложить, шов сейчас):** сетка — единственное пространство маршрутизации; при трансляции в VDA5050 Order добавлять NURBS-`trajectory` на рёбрах поворотов (Безье 3-й степени ≈ четверть-дуга; Безье — частный случай NURBS, конверсия тривиальна). Слать только роботам с задекларированной поддержкой в factsheet (гейт по factsheet — сцепка с Темой B). Шов (≈0.5 дня): в VDA5050-адаптере вынести построение `Edge` в `buildEdge(fromNode, toNode, robotProfile)` — позже обрастёт trajectory. Сама фича — **3–5 дней** (генерация скруглений + исполнение в VirtualAgvAdapter-подклассе + Pixi-визуализация), делать при физическом роботе с поддержкой или запросе клиента.

**Риски «пропустить»:** (1) тендер с «free navigation» в чек-листе — формулировка «гибридная навигация: SLAM-локализация + графовая маршрутизация, как у SEER RDS» — честно и совпадает с реальностью; (2) нестеллажные площадки — плотнее сетка/декорированный граф, не смена планировщика.

---

## Тема B: библиотека моделей роботов

### B1. VDA5050 factsheet — стандарт дал почти всю схему

Factsheet есть с VDA5050 **2.0** (в 1.1 отсутствует; наш таргет 2.0/2.1 имеет). Поля (`vda-5050-types-2.0.d.ts`):
- `typeSpecification`: `agvClass` (CARRIER/CONVEYOR/FORKLIFT/TUGGER), **`agvKinematic` (DIFF/OMNI/THREEWHEEL)**, `maxLoadMass`, `localizationTypes`, `navigationTypes`, `seriesName`. **Ackermann в enum 2.0/2.1 нет** (только в 3.0) — своё поле kinematics со значением `ackermann`, маппить в THREEWHEEL при экспорте.
- `physicalParameters`: `length`, `width`, `heightMax/Min`, `speedMax/Min`, `accelerationMax`, `decelerationMax`.
- `agvGeometry`: `envelopes2d` (полигоны оболочки — вход для footprint), `wheelDefinitions`.
- `loadSpecification`: `loadPositions`, `loadSets`.
- `protocolLimits` + `protocolFeatures` (`optionalParameters` — в т.ч. trajectory; `agvActions`).
- «Калибровок» в стандарте нет — бортовое.

**vda-5050-lib (локально проверено):** `Topic.Factsheet` в client-types; `AgvController` хранит `_currentFactsheet`, поддерживает instant action `factsheetRequest`; адаптер отдаёт через `updateFactsheet()`. **Со стороны мастера** готового трекинга нет — но `MasterControlClient.subscribe(Topic.Factsheet, ...)` + отправка `factsheetRequest` при коннекте = «обернуть», не «строить».

### B2. openTCS и Open-RMF

- **openTCS Vehicle** (MIT): `length` (единственный габарит), `energyLevelCritical/Good/FullyRecharged/SufficientlyRecharged` (пороги — вход для дыры №1), `maxVelocity/maxReverseVelocity`, `envelopeKey` (с 5.x пути/точки описывают envelope-геометрии — их ответ на «робот больше ячейки», идея портируема).
- **Open-RMF fleet config** (Apache-2.0, fleet_adapter_template/config.yaml): `limits {linear, angular}`, `profile: {footprint: radius, vicinity: radius}` — **двухрадиусная модель**: footprint = жёсткий габарит, vicinity = зона вежливости; `reversible`, `battery_system`, `recharge_threshold`, `recharge_soc`. Battery/mechanical для предсказания расхода — оверкилл сейчас; `recharge_*` — входы дыры №1.
- Синтез: factsheet как канон полей + `envelopeKey`-идея openTCS + `footprint/vicinity` из RMF.

### B3. Эскиз

**1) persistence** (миграция):
```sql
create table if not exists robot_models (
  id            text primary key,          -- 'seer-sjv-600', 'sim-default'
  name          text not null,
  agv_class     text not null,             -- CARRIER|FORKLIFT|TUGGER|CONVEYOR
  kinematics    text not null,             -- diff|omni|threewheel|ackermann
  length_m      real not null,
  width_m       real not null,
  height_m      real,
  speed_max     real not null,
  accel_max     real, decel_max real,
  max_load_kg   real not null,
  footprint_cells integer not null default 1,  -- 0=1x1, 1=3x3 (чебышёвский радиус)
  vicinity_cells  integer not null default 0,  -- RMF-style зона вежливости (soft)
  charge_threshold real default 0.2,
  charge_target    real default 0.9,
  factsheet_json  jsonb                    -- сырой factsheet как источник истины
);
-- robots: + model_id text references robot_models(id)
```
Поток: робот коннектится → мастер шлёт `factsheetRequest` → handler апсертит robot_models (ключ = `manufacturer/seriesName`) и линкует робота; `footprint_cells = ceil(max(length,width) / (2*cell_size) - 0.5)`. Ручной CRUD через REST для роботов без factsheet (Modbus-тележки).

**2) sim-фабрика** (`packages/sim/src/fleet.ts`): `SpawnFleetOpts.model` → опции VirtualAgvAdapter (`vehicleSpeed` ← speed_max, batteryMaxReach) + `updateFactsheet()` с синтезированным factsheet — sim-флот отдаёт factsheet по тому же протоколу, что железо; пайплайн тестируется end-to-end. Смешанный флот = `{model, count}[]`.

**3) габариты в резервациях**: PIBT планирует по номинальной ячейке (алгоритм не трогаем). На слое claim'ов: путь робота с `footprint_cells = r > 0` через `expandFootprint(cells, r)` — соседи в чебышёвском радиусе r (Минковский след), порядок пути сохранён, дедуп есть. Prefix-семантика сохраняется: обрезка на первой чужой ячейке *расширенного* следа. Инвариант: проход ≥ (2r+1) ячеек, иначе робот не планируется — валидация при загрузке карты (пер-модель маска проходимости: BFS-эрозия свободного пространства радиусом r). `vicinity_cells` — не hard-резервация, а штраф в эвристике диспетчера (не парковать idle вплотную к крупному).

Упрощение (зафиксировать): расширение квадратное, без ориентации прямоугольного робота — для латентных AMR 0.9×0.7 на ячейке 1 м достаточно (r=0); ориентированный footprint (вилочный 1.7×1.1 при развороте) = отложенный этап, донор — envelope-механизм openTCS.

### Вердикты и трудоёмкость

| Кусок | Вердикт | Дни |
|---|---|---|
| Factsheet ingest (subscribe + factsheetRequest + upsert) | обернуть vda-5050-lib | 1 |
| robot_models таблица + repos + REST CRUD | с нуля (по образцу существующих repos) | 1 |
| Sim-фабрика моделей + synthesized factsheet | обернуть VirtualAgvAdapter | 1 |
| Footprint в резервациях + эрозия маски + тесты | портировать идеи (openTCS envelopes, RMF profile) | 1.5–2 |
| Дашборд: карточка модели, габарит в Pixi | с нуля | 0.5–1 |
| **Итого** | | **5–7** |

### Риски

1. **Мусорные factsheet** (поля опциональны, вендоры заполняют частично) — ручной override обязателен, factsheet лишь предзаполнение (встроено в дизайн).
2. **Крупный робот + узкие проходы**: эрозия может отрезать связность — явный алерт «модель X не достигает зоны Y» при валидации, иначе тихие вечные заказы.
3. **Смешанный флот в PIBT**: приоритетное наследование не знает про разные footprint; расширение на claim-слое безопасно (робот ждёт), но может резать throughput в узких местах — замерить на `pnpm demo` с 1 «крупным» роботом.
4. Trajectory-гейт (Тема A′) зависит от `protocolFeatures` ingest — если резать Тему B, резать с конца таблицы, не с factsheet.

### Связь с другими дырами

Тема B — фундамент для №1 (зарядка: charge_threshold/target пер-модель), №4 (Modbus-тележки = модели без factsheet), №2 (лимит на зону в единицах footprint).

**Источники:** seer-robotics.ai/blog/pallet-jack-robots · seer-group.com AMB-300 · github.com/VDA5050/VDA5050 (VDA5050_EN.md) · coatyio.github.io/vda-5050-lib.js Trajectory API (MIT; локально верифицировано) · opentcs.org/docs/6/user · open-rmf/fleet_adapter_template config.yaml (Apache-2.0) · arXiv:2311.14615 · локально: packages/core/src/{reservations,map}.ts, packages/sim/src/fleet.ts, packages/persistence/src/migrations.ts, packages/shared/src/types.ts.

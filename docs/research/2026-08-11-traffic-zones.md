# Зоны трафика: односторонние проходы, запретные зоны, лимиты на зону, блок-секции

Дата: 2026-08-11. Изучено по исходникам: openTCS (clone, SPDX `MIT` в каждом файле), `continua-systems/vdma-lif` (LICENSE = MIT), Open-RMF — по официальной книге/дискурсу (Apache-2.0). Наш код: `packages/core/src/{map,router,reservations}.ts`, `packages/orchestrator/src/orchestrator.ts`.

## 1. openTCS (MIT) — доменная модель Block и алгоритм аллокации

### Доменная модель

**`Block`** (`opentcs-api-base/.../data/model/Block.java`) — именованный **набор ресурсов** (`members: Set<TCSResourceReference>` — точки И пути вперемешку) плюс тип:
- `SINGLE_VEHICLE_ONLY` — все ресурсы блока — только одно ТС одновременно (перекрёсток, узкий проход, лифтовая зона).
- `SAME_DIRECTION_ONLY` — несколько ТС, но только вошедшие в блок **в одном направлении** (коридор-«шлюз»).

**`Path`** — **направленное** ребро с полями: `maxVelocity` («0 = вперёд запрещено»), `maxReverseVelocity` («0 = назад запрещено»), `locked` (исключить из маршрутизации, динамика).

**Односторонность в openTCS = свойство ребра, а не зоны.** `PathEdgeMapper.translatePaths()`: forward-ребро если `maxVelocity != 0`, reverse — если `maxReverseVelocity != 0`; `locked` → вес `NaN` (выкинут); `Infinity`/`NaN` от edge-evaluator'ов тоже исключают. Три механизма запрета: скорость=0 (статика), locked (динамика), вес=∞ (политика/пер-ТС через `EdgeEvaluatorComposite` — evaluators пер-ТС). Плюс `ResourceAvoidanceExtractor` — запрет на уровне заказа.

### Алгоритм аллокации (scheduler)

`DefaultScheduler` (`opentcs-strategies-default/.../scheduling/`):
1. **claim(client, List<Set<Resource>>)** — ТС декларирует будущую последовательность наборов ресурсов.
2. **allocate(client, Set)** — только голова claim-очереди (`isNextInClaim`). Запрос в `AllocatorTask`.
3. `AllocatorTask` → модули-советники (`Scheduler.Module.mayAllocate()`): каждый — право вето. Вето → `deferredAllocations`.
4. **free(client, resources)** → `RetryAllocates` — повтор всех отложенных. Это «claim → allocate → free behind → retry deferred».

**`SingleVehicleBlockModule.mayAllocate()`** — блок реализован НЕ счётчиком, а **расширением множества**: запрошенные ресурсы через `expandResources()` — ресурс в блоке → добавляются **все** члены блока; затем обычная `ReservationPool.resourcesAvailableForUser(expanded)`. Занять ячейку блока можно только если весь блок свободен. Ноль нового состояния.

**`SameDirectionBlockModule`** — состояние: пер-блок `BlockPermission { clients: Set, entryDirection: String|null, pendingRequests: Queue }`:
- направление входа из свойства пути `tcs:blockEntryDirection` (fallback — имя пути);
- вход разрешён если `entryDirection == null` или совпадает;
- разрешение снимается, когда клиент не держит ни одного ресурса блока; клиентов не осталось → `entryDirection = null`;
- двухфазность: `mayAllocate` ставит в очередь, `prepareAllocation` подтверждает — защита от гонок.

**Чего в openTCS НЕТ:** лимита «не более N роботов в зоне» (только 1 или ∞-в-одну-сторону). Счётчик-семафор делаем сами (тривиально).

## 2. Open-RMF / rmf_traffic (Apache-2.0) — только концепты

- **Lane — направленная по определению**: `Graph::add_lane()` — односторонняя entry→exit; двусторонний проход = две полосы. В traffic-editor флаг `bidirectional` просто генерит обе.
- **`Lane::Properties`**: `speed_limit(): optional<double>`, `in_mutex_group(): string`.
- **Mutex groups** — главное золото: полосам/вершинам присваивается имя группы; перед въездом на любой ресурс группы робот обязан **захватить лок группы**; лок один. Аналог openTCS `SINGLE_VEHICLE_ONLY`, но как **именованный семафор ёмкости 1** — легко обобщается до ёмкости N. «Smart traffic lights embedded into maps».
- **Lane closures** — runtime open/close (`LaneRequest`/`ClosedLanes`): планировщик перестаёт использовать закрытые; текущие проезды доезжают. Для нашего API: `PATCH /lanes {closed: [...]}` → инвалидация кэша маршрутов, живые гранты не отзываются.
- Negotiation/schedule database не нужны — мы централизованы, у нас ReservationTable.

Источники: Traffic Editor / rmf-core главы ros2multirobotbook, rmf_traffic Graph.hpp, discourse: mutex group performance, lane closure caveat.

## 3. LIF (VDMA Layout Interchange Format)

Схема `continua-systems/vdma-lif` (MIT; quicktype-парсеры TS/Python/C# в пакетных менеджерах; официальный VDMA guideline 1.0.0, PDF vdma.org `FuI_Guideline_LIF_GB.pdf`).

Структура: `metaInformation` + `layouts[]` (слой = этаж, `layoutLevelId`) → `nodes[]`, `edges[]`, `stations[]`.
- **Ребро направленное**: `{ edgeId, startNodeId, endNodeId, vehicleTypeEdgeProperties[] }`. Двусторонний проход = **два ребра**. Односторонность = отсутствие встречного ребра.
- **Пер-тип-ТС свойства ребра**: `maxSpeed`, `maxRotationSpeed`, `vehicleOrientation`, `rotationAllowed`, `minHeight/maxHeight`, `loadRestriction`, `trajectory` (NURBS), `actions`, `reentryAllowed`. Ребро без записи для типа ТС = непроходимо для него — так кодируются пер-роботные запреты.
- **Зон в LIF НЕТ вообще** (grep «zone» — 0). LIF — формат обмена геометрией трасс, не правил трафика. Зоны живут в нашем слое конфигурации; при импорте LIF маппим nodes/edges, зоны — отдельно (не изобретать нестандартные поля внутри LIF).

## 4. Интеграция в наш PIBT-роутер

Уже есть (половина фичи готова):
- `map.ts`: adjacency из рёбер с флагом `bidirectional` — **направленный граф уже поддержан**, `grid()` просто всегда генерит двусторонние. `bfsDistances` по направленной adjacency.
- `router.ts` (PIBT): кандидаты = `neighbors(at) + stay` — односторонность подхватится автоматически; push-цепочки толкают только по исходящим.
- `reservations.ts`: prefix-grant `claim()` — идеальная точка врезки зонных гейтов; `orchestrator.ts` держит инвариант «ReservationTable = source of truth» + счётчик extension-blocked тиков (contention-алармы).

### Эскиз дизайна

**`packages/core/src/zones.ts`** (новый):

```ts
type ZoneKind = "forbidden" | "capacity" | "same-direction";
interface Zone {
  id: string;
  kind: ZoneKind;
  cells: ReadonlySet<CellKey>;   // членство по ячейкам, как members у openTCS
  capacity?: number;             // kind=capacity; SINGLE_VEHICLE_ONLY = capacity:1
}

class ZoneRegistry {
  zonesOf(cell: CellKey): Zone[];              // прекомпилированный индекс cell→zones
  canEnter(robot: RobotId, cell: CellKey, dir: Dir): boolean;
  onGranted(robot, cells); onReleased(robot, cells);  // счётчики
}
```

1. **Запретные зоны** — уровень карты: узлы выкидываются из adjacency (аналог `locked`+`NaN`). Динамическое закрытие = пересборка adjacency + **сброс `distanceCache`** + одноразовый re-route живых легов.
2. **Односторонние проходы** — уже поддержаны; добавить (а) декларативный конфиг «коридор X: направление →» поверх `grid()`, (б) API-ручку закрытия/переворота, (в) инвалидацию `distanceCache`. LIF-совместимо по построению.
3. **Лимит N роботов на зону (блок-секции = N=1)** — счётчик-семафор в связке с `ReservationTable.claim()`:
   - робот «в зоне Z», если хоть одна granted-ячейка ∈ Z (семантика openTCS `blockResourcesAllocatedByClient`);
   - при prefix-гранте: ячейка зоны Z, робот не в Z и `count(Z) >= capacity` → грант обрезается на этой ячейке (робот ждёт перед входом — мягкая деградация, prefix-семантика уже есть);
   - инкремент при первом гранте ячейки Z, декремент в `release`/`releaseAll` при уходе последней.
   - Выбор: **семафор (RMF-стиль), не expand-set (openTCS-стиль)** — expand-set не обобщается на N>1 и дороже на сетке, где блок = десятки ячеек.
4. **Same-direction блоки** — прямой порт `BlockPermission`: `{ holders: Set<RobotId>, dir: Dir | null }`, направление = нормализованный вектор ребра входа (сетка — 4 значения); сброс `dir` при опустении. ~60 строк + тесты.
5. **PIBT-интеграция — двухуровневая защита**:
   - **мягкий фильтр в роутере**: `PibtRouter` получает опциональный `zoneGate: (robotId, from, to) => boolean`; кандидаты в переполненную/встречную зону пропускаются → роутер планирует ожидание/обход, а не бьётся о claim;
   - **жёсткий гейт в ReservationTable** — источник истины (п. 3).
6. **Веса рёбер / speed limits** (фаза 2): `MapEdge.weight` (speed-limit → weight>1), `bfsDistances` → Dijkstra. PIBT-кандидаты сортируются по той же `distance()` — изменений в роутере ноль. Внимание: `distanceCache` пер-источник на направленном графе корректен, но экономнее reverse-BFS от каждой цели по транспонированной adjacency — на 20×10 не болит, на большой карте переделать.

**Формат конфига**: зоны в нашем map-JSON (`zones: [...]` рядом с `nodes/edges`), в LIF при экспорте не пишутся; в редакторе карт — прямоугольники поверх сетки (members из bbox).

## Вердикты и трудоёмкость (сильный dev + ИИ)

| Фича | Донор | Вердикт | Дни |
|---|---|---|---|
| Односторонние проходы | LIF/RMF-семантика; наш map уже умеет | **с нуля** (мелочь поверх готового) | 0.5–1 |
| Запретные зоны + runtime closure | openTCS `locked`+NaN, RMF LaneRequest | **портировать идеи** | 1 |
| Лимит N на зону + блок-секции (N=1) | RMF mutex group (семантика), openTCS ReservationPool (жизненный цикл) | **портировать идеи** | 1.5–2 |
| Same-direction блоки | openTCS `SameDirectionBlockModule` | **портировать идеи** (прямой порт ~60 строк) | 1–1.5 |
| Веса рёбер / speed limits | openTCS EdgeEvaluator, RMF speed_limit | **с нуля**, фаза 2 | 1–2 |
| LIF импорт/экспорт | `continua-systems/vdma-lif` (MIT, готовый TS-парсер) | **обернуть**, вместе с редактором карт | 1–2 |
| Open-RMF код | — | **пропустить** (только концепты, ROS) | — |

**Ядро темы: ~4–5.5 dev-дней.** Всё в MIT/Apache-периметре.

## Риски

1. **PIBT против односторонности**: push-цепочка не может вытолкнуть агента против one-way ребра — в односторонних тупиках возможен затор. Митигация: «idle-роботы не паркуются в one-way/зонах» + существующий contention-аларм.
2. **Livelock у входа в capacity-зону**: роутер без `zoneGate` вечно предлагает вход, claim вечно режет грант. Мягкий фильтр в роутере обязателен, не «потом».
3. **Справедливость**: openTCS ведёт FIFO pendingRequests — у нас prefix-grant без очереди, возможно голодание у зоны; принять для v1, при жалобах — FIFO-тикеты на вход.
4. **Инвалидация `distanceCache`** при закрытии зон/рёбер — забыть = молчаливо-кривые эвристики. Единственный метод `map.mutate()` с обязательным сбросом.
5. **Same-direction семантика openTCS консервативна**: направление сбрасывается только при полном опустении — встречный трафик ждёт дольше оптимального. Осознанная простота, копируем как есть.
6. **LIF не несёт зоны** — не расширять LIF-файл нестандартными полями (сломаем интероп); зоны — отдельный конфиг.

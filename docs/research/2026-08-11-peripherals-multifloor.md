# Периферия (двери/лифты/конвейеры, Modbus TCP) + Мультиэтаж / группы карт

Дата: 2026-08-11. Все лицензии проверены по первоисточникам. Все доноры проходят гейт MIT/Apache/BSD/EPL/ISC.

---

## ТЕМА A: Периферия

### A1. modbus-serial (npm) — подтверждено, брать как есть

- github.com/yaacov/node-modbus-serial, npm `modbus-serial` v8.0.25. **Лицензия: ISC** — проходит гейт.
- 731★, активный CI, свои `.d.ts`. TCP: `TcpPort` (client) + RTU/ASCII/Telnet/UDP + **ServerTCP** (fake-ПЛК для тестов — sim-дверь для CI бесплатно). FC1–6, FC15–16, FC22, FC43/14 + custom FC.
- **Вердикт: обернуть.** Нюанс — одна очередь на соединение и слабый auto-reconnect: тонкий wrapper (сериализация запросов + reconnect-supervisor + poll loop), ~0.5 дня.

### A2. openTCS peripheral jobs API (MIT) — главный донор архитектуры

Файлы: `opentcs-api-base/.../data/peripherals/{PeripheralJob,PeripheralOperation}.java`, `data/model/PeripheralInformation.java`, `opentcs-kernel/.../vehicles/{PeripheralInteraction,PeripheralInteractor}.java`, `opentcs-strategies-default/.../peripherals/dispatching/*`.

**Модель данных (в TS почти 1:1):**
- **`PeripheralOperation`** = `{ location, operation: string, executionTrigger, completionRequired: bool }`. Триггеры: `IMMEDIATE` | `AFTER_ALLOCATION` (после захвата пути, ДО движения — «открой дверь до въезда») | `AFTER_MOVEMENT` («закрой за мной»).
- **Операции висят на рёбрах**: `path.getPeripheralOperations()` — свойство ребра маршрута, не отдельный шаг заказа. Так «робот ждёт дверь» получается бесплатно.
- **`PeripheralJob`** = `{ reservationToken, relatedVehicle, relatedTransportOrder, peripheralOperation, state }`; states: `TO_BE_PROCESSED → BEING_PROCESSED → FINISHED | FAILED`.
- **`PeripheralInformation`** на устройстве: `{ reservationToken, state: NO_PERIPHERAL|UNKNOWN|UNAVAILABLE|ERROR|IDLE|EXECUTING, procState, peripheralJob }`.

**Механика «робот ждёт дверь» (`PeripheralInteractor`):**
1. При подготовке каждого `MovementCommand` операции ребра группируются по триггеру → pre-movement и post-movement interactions.
2. `interaction.start()` создаёт PeripheralJob'ы; с `completionRequired=true` — в pending-список.
3. **MovementCommand не отправляется роботу, пока `isWaitingForPreMovementInteractionsToFinish()`** — пока все completionRequired-job'ы не FINISHED. Fail одного = fail interaction → робот стоит, тревога.
4. Без completionRequired — interaction мгновенно FINISHED (fire-and-forget, «мигнуть лампой»).

**Резервация периферии:**
- `reservationToken = transportOrder.peripheralReservationToken ?? vehicle.name` — устройство резервируется «за токеном»; job'ы одного заказа шарят токен.
- Диспетчер фазами: `AssignReservedPeripheralsPhase` → `AssignFreePeripheralsPhase` → `ReleasePeripheralsPhase`. Release: `state==IDLE && procState==IDLE && token != null`.
- Драйверный шов: `PeripheralCommAdapter { process(job, callback), abortJob() }` + loopback-адаптер как референс sim-устройства.

**Вердикт: портировать идеи (модель целиком).** Лучшая открытая модель периферии, совместима с нашей claim→allocate→free семантикой.

### A3. touchmii/OpenTCS-4 (MIT, база openTCS 4.17) — референс регистровой карты

- `openTCS-CommAdapter-Modbus/`, `Simulator-Modbus/`; `AgvTelegramNew.java` + `AgvInfo.java`. Карта: **FC3 read 60 holding registers с addr 0** (весь стейт одним запросом: позиция, скорость, углы, orderID/orderStatus, батарея, вилы, load/charge, exception) — **запись пути FC16 в addr 100+**, команды FC6: **addr 55 pause/resume, addr 56 abort, addr 57 alarm reset**.
- **Вердикт: только идеи, кода не брать** (Java, качество среднее). Ценность: (а) паттерн «весь стейт одним block-read, команды отдельными регистрами» — так же выглядят двери/конвейеры на ПЛК; (б) Simulator-Modbus подтверждает практику sim-устройства на Modbus-сервере. Шаблон нашей конфигурируемой register map.

### A4. Open-RMF door/lift adapters (Apache-2.0) — стейт-машины, концепты

`open-rmf/rmf_internal_msgs` + ros2multirobotbook.

**Двери:** `DoorMode = CLOSED|MOVING|OPEN|OFFLINE|UNKNOWN`; `DoorRequest {requester_id, door_name, requested_mode}`; `DoorState`. Концепты:
- **Supervisor-gatekeeper**: запросы в супервизора, он ведёт **сессии** (`DoorSessions` + heartbeat) и **отменяет команды в обход него** — дверь не закроется, пока жива чужая сессия.
- Цикл: request OPEN → poll до MODE_OPEN → проехать → release session → супервизор закрывает, когда сессий нет. Таймаут на каждую фазу.

**Лифты:** `LiftRequest { session_id, request_type: END_SESSION|AGV_MODE|HUMAN_MODE, destination_floor, door_state }`; `LiftState { available_floors[], current_floor, destination_floor, door_state, motion_state, current_mode (FIRE/OFFLINE/EMERGENCY), session_id }`. Концепты:
- **Эксклюзивное владение по `session_id`** до явного `REQUEST_END_SESSION` — ответ на deadlock «два робота зовут лифт».
- **AGV_MODE = двери держатся открытыми, пока кабина стоит** — обязательный флажок в драйвере лифта.
- FIRE/EMERGENCY читаются и мгновенно инвалидируют планирование через лифт.

**Вердикт: портировать концепты** (session-владение, gatekeeper, режимы, этажи по именам). ROS-код не трогаем.

### Вердикт по Теме A и эскиз

**Строить свой `@tez/peripherals`: модель openTCS + стейт-машины RMF + драйвер на modbus-serial.**

```
@tez/peripherals
  device.ts        PeripheralDevice { id, kind: door|lift|conveyor|charger,
                     info: {state, procState, reservationToken, currentJob} }
  job.ts           PeripheralJob { token, op, relatedVehicle/Order,
                     state: TO_BE_PROCESSED→BEING_PROCESSED→FINISHED|FAILED }
  dispatcher.ts    фазы assignReserved → assignFree → release (порт openTCS)
  drivers/
    driver.ts      DeviceDriver { connect, poll, execute(op, cb), abort }
    modbus-tcp.ts  на modbus-serial: registerMap-конфиг
                   { poll: {addr, len, decode}, ops: { open: {write:[{addr,val}],
                     confirm:{addr, equals, timeoutMs, retries}} } }
    sim.ts         loopback-аналог + ServerTCP fake-ПЛК для интеграционных тестов
@tez/core (правки)
  edge.peripheralOps = [{deviceId, op, trigger: afterAllocation|afterMovement,
                         completionRequired}]
  vehicle-adapter: не расширять VDA5050 base за ребро с pending
                   completionRequired-interaction (дверь = граница base/horizon)
```

Дашборд: статус-виджет устройств + тревога FAILED-job (в существующий сплит тревог).

**Трудоёмкость: 7–10 дней.** Модель+диспетчер+тесты 2–3; Modbus-драйвер+register map+sim-ПЛК 2–3; интеграция с base-границей в VDA5050-адаптере 2–3; дашборд 1.

**Риски:** (1) реальные ПЛК разношёрстны — register map только конфигом, не кодом; (2) безопасность: «дверь открыта» — только по датчику/регистру, никогда по таймеру; completionRequired по умолчанию true для дверей; (3) modbus-serial reconnect писать самим; (4) конвейер: долгоживущий op (handshake load/unload) — job с двумя confirm-фазами.

---

## ТЕМА B: Мультиэтаж / группы карт

### B1. Доноры

**openTCS (MIT):** первоклассного мультиэтажа **нет**. `Layer`/`LayerGroup` — чисто презентационная группировка, роутер не видит. Мультиэтаж — соглашением: подграфы этажей в одном графе + Path через Location лифта. «Граф один, этаж — атрибут» — рабочий, но грязный паттерн; нам не нужен.

**Open-RMF (Apache-2.0):** первоклассная модель, `rmf_building_map_msgs`: `BuildingMap { levels: Level[], lifts: Lift[] }`; `Level { name, elevation, nav_graphs[] }` — **отдельные графы на этаж**; `Lift { name, levels[], doors, ref_x/ref_y/ref_yaw, width, depth }` — reference orientation для выравнивания систем координат этажей + габариты кабины (влезет ли робот). Лифт = ребро мета-графа + эксклюзивный ресурс с session_id.

**VDA5050 (2.1.0 и main):**
- `nodePosition.mapId` обязателен у узлов с позицией; `agvPosition.mapId` = активная карта. **Смена карты — просто узлы с новым mapId в одном order**; спека прямо описывает лифт: робот «исчезает с карты этажа отправления и появляется на lift-node карты этажа назначения».
- **2.1 добавила map management**: `maps[]` в state (`mapId, mapVersion, mapStatus`), instant actions `downloadMap / enableMap / deleteMap`, `UNKNOWN_MAP_ID`. Fleet control отвечает, чтобы карты были ENABLED до order. vda-5050-lib 1.7.2 (типы 2.1) покрывает. В 3.0 сверху zoneSet'ы на mapId (задел под зоны, пока не надо).

### B2. Эскиз для нашего grid-роутера

```
@tez/core
  map-registry.ts   MapRegistry: Map<mapId, Grid>  (mapId = floorId)
  meta-graph.ts     узлы = этажи, рёбра = InterFloorLink
                    { liftId, from:{mapId,cell}, to:{mapId,cell},
                      cabinCell, boardingCells }
@tez/router
  двухуровневый роутинг:
    1) мета-поиск (Dijkstra по этажам; вес лифт-ребра = ожидание+ход)
    2) PIBT НА КАЖДОМ ЭТАЖЕ НЕЗАВИСИМО — своя резервационная таблица
       на mapId; окна этажей не пересекаются
@tez/peripherals
  lift-resource.ts  стейт-машина поверх Темы A:
    IDLE → CALLED(session=vehicleId) → ARRIVED → BOARDING →
    RIDING → ARRIVED_DEST → EXITING → RELEASE(END_SESSION)
    очередь FIFO/priority; AGV_MODE (двери держать); FIRE/ERROR → блок этажа
@tez/vda5050-adapter
  межэтажный заказ: nodes [... liftNode(mapId=F1), liftNode'(mapId=F2) ...];
  base расширяется за liftNode только после RIDING→ARRIVED_DEST
  (та же base/horizon-граница, что для дверей);
  sim: teleport-хэндлер в нашем адаптере VirtualAgvAdapter
@tez/dashboard
  floor switcher (рендерим один этаж), робот в лифте = бейдж на обоих
```

Многоэтажность заказов = штраф стоимости в диспетчере (лифт дорогой) — венгерка не меняется, меняется cost-функция. Зарядка/парковка (дыра №1) становятся per-mapId — учесть в её дизайне сразу.

**Вердикт: с нуля на своих структурах; идеи — RMF BuildingMap/Lift + VDA5050 mapId-семантика.** Доноров кода нет и не нужно.

**Трудоёмкость: 6–9 дней** (при готовой Теме A): MapRegistry+мета-роутер 2; лифт-ресурс поверх peripherals 2; изоляция PIBT/резерваций per mapId 1–2; mapId в адаптере + sim-teleport + интероп-тест 1–2; floor switcher 1–2. **Порядок: Тема A раньше Темы B** — лифт-ресурс на 80% переиспользует периферийную машинерию.

**Риски:** (1) **coaty VirtualAgvAdapter может не поддерживать смену mapId/teleport — проверить исходники до кодинга; вероятно, нужен наш форк-хук в sim** (главный технический риск); (2) PIBT priority inheritance не действует сквозь этажи — разруливает только очередь лифта, лифт легко становится bottleneck (нужен aging в очереди); (3) миграция персистентности: kpi/recorder и резервации получают map_id; (4) реальные лифты редко дают чистый Modbus — часто сухие контакты через шлюз, закладывать время на полевую наладку.

**Гейт:** modbus-serial ISC ✅ · openTCS MIT ✅ · touchmii/OpenTCS-4 MIT ✅ · rmf_internal_msgs / rmf_building_map_msgs Apache-2.0 ✅ · VDA5050 спека CC-BY 4.0 (стандарт, реализуем сами) ✅.

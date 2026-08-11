# Auth (пользователи/RBAC/аудит) + Долгосрочная статистика/отчёты

Дата: 2026-08-11. Лицензионный гейт: MIT/Apache/BSD/EPL/ISC. Все лицензии проверены по LICENSE-файлам репозиториев (raw GitHub / GitHub API `/license`), не по README.

Контекст из репо: `@tez/api` — Fastify 4 + `@fastify/websocket` 10, WS-стрим `GET /ws/state` 10Hz (packages/api/src/ws.ts); `@tez/persistence` — pglite/pg за SqlDriver-швом, свои миграции, `kpi_snapshots(at, orders_per_hour, avg_cycle_ms, utilization)` пишутся recorder'ом с retention; `@tez/dashboard` уже несёт **Recharts 3.10.1**.

---

## ТЕМА A: Auth

### A.1 Кандидаты

| Кандидат | Лицензия | Статус | Вердикт |
|---|---|---|---|
| **better-auth** | **MIT** (LICENSE.md) | Активен, VC-funded, официальный Fastify-гайд, admin-плагин с RBAC | Лицензионно чист, но **не брать** (см. A.2) |
| **lucia** | MIT | **DEPRECATED март 2025** (discussion #1714). Сайт lucia-auth.com теперь учебник «auth с нуля» | **Портировать идеи** — буквально его новое назначение |
| **@fastify/jwt** + **@fastify/auth** | MIT + MIT | Активны (fastify org) | Не основа (JWT хуже сессий для нашего кейса); @fastify/auth тривиален, не нужен |
| **iron-session** | MIT | Заточен под Next.js/stateless cookie | **Пропустить**: stateless = нет server-side revoke («уволили оператора — сессия живёт»), для аудита не годится |
| **Свой стек**: `argon2` + сессии в pg | node-argon2 MIT | Активен, нативный биндинг референсного argon2 | **ПОБЕДИТЕЛЬ** |

### A.2 Почему не better-auth, хотя MIT

1. **Владение схемой.** Хочет свои таблицы через собственный CLI-мигратор поверх Kysely; у нас единственный источник правды — свой `migrations.ts` за SqlDriver-швом. Скрестить = два мигратора или ручной перенос schema-generate + молиться при апгрейдах.
2. **pglite.** Ожидает pg Pool / Kysely-диалект; под pglite нужен сторонний диалект — зависимость вне гейта проверок.
3. **Масштаб мимо.** Фреймворк под SaaS: OAuth, magic links, организации, email-флоу. Наш кейс — on-prem склад, 5–30 пользователей, 3 роли, ни одного внешнего IdP. ~5% библиотеки, 100% её поверхности атаки.
4. Его RBAC — permission-модель `statement/action`; нам достаточно enum-роли в строке.

Когда пересмотреть: заказчик с SSO/LDAP/Keycloak → не better-auth, а OIDC-клиент поверх нашего же session-слоя (openid-client, MIT).

### A.3 Дизайн (свой стек, идеи из Lucia)

**`@tez/persistence`** (миграция N+1):
```sql
users(id, username unique, password_hash, role check(role in ('operator','supervisor','admin')),
      display_name, disabled bool default false, created_at)
sessions(id_hash pk, user_id fk, created_at, expires_at, last_seen_at)  -- храним ХЕШ токена (SHA-256), как учит Lucia
audit_events(id bigserial, at, user_id, username_snapshot, action, entity, entity_id, payload jsonb, ip)
```
Repos: `UsersRepo`, `SessionsRepo` (create/validate/revoke/revokeAllForUser/gc), `AuditRepo.append` + `list`. Пароли — `argon2id` с дефолтами node-argon2. Токен: 32 байта `crypto.randomBytes` → base64url клиенту, в БД только SHA-256 (кража дампа БД ≠ кража сессий). Sliding expiration (30 дней, продление при активности) — паттерн из lucia-auth.com/sessions.

**`@tez/api`** — `auth.ts` плагин:
- Роуты: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET/POST /auth/users` (admin), `GET /auth/audit` (supervisor+).
- Cookie `tez_session`: `HttpOnly; SameSite=Strict; Secure` (за Caddy), `@fastify/cookie` (MIT).
- `onRequest`-хук: cookie → `SessionsRepo.validate` → `request.user`; guard `requireRole(minRole)` как preHandler (operator < supervisor < admin). ~15 строк.
- Bootstrap: пустая таблица users → создаётся `admin` с одноразовым паролем в stdout (паттерн Mosquitto/Grafana).
- **Аудит — библиотека не нужна.** Глобальный `onResponse`-хук: мутирующий метод и route не в skip-списке → `AuditRepo.append({user, action: routeId, payload: sanitize(body), ip})`. Плюс явные append'ы из доменных мест (cancelOrder, смена карты, ручное управление). Append-only, retention с длинным горизонтом.

**WS-аутентификация 10Hz-стрима**:
1. **Cookie (выбор, 0 доп. кода).** WS-upgrade — обычный HTTP GET, браузер шлёт куки; дашборд same-origin. В `wsRoutes` тот же auth-хук — `@fastify/websocket` прогоняет upgrade через Fastify-хуки, reject до апгрейда. `SameSite=Strict` закрывает CSWSH; дополнительно проверять `Origin` в preValidation.
2. Ticket-эндпоинт (`POST /auth/ws-ticket` → одноразовый токен 30 сек) — запасной для cross-origin.
3. Токен в `Sec-WebSocket-Protocol` — не нужен, пока есть №1. **Долгоживущий токен в query — не делать** (оседает в access-логах).

10Hz-перфоманс: auth только на upgrade; ре-валидация лениво раз в ~60 сек + disconnect при отзыве сессии.

### A.4 Вердикт и трудоёмкость

**С нуля, ~600 LOC, по конспекту Lucia.** Зависимости: `argon2`, `@fastify/cookie` (обе MIT).

| Работа | dev-дни |
|---|---|
| Миграция + repos + тесты (pglite) | 0.5 |
| Auth-плагин: login/logout/me, cookie, guards, bootstrap-admin | 1 |
| RBAC-разметка роутов + WS preValidation + Origin-check | 0.5 |
| Аудит-хук + `/auth/audit` + retention | 0.5 |
| Дашборд: логин, `useSession`, скрытие кнопок по роли, Users/Audit (admin) | 1–1.5 |
| **Итого** | **3.5–4** |

**Риски:** (1) node-argon2 нативный — в Docker build-стадия или `@node-rs/argon2` (MIT, prebuilt); (2) свой crypto-код — строго рецепты Lucia, не изобретать; (3) `SameSite=Strict` ломает «открыли дашборд по ссылке из 1C» — тогда `Lax`.

---

## ТЕМА B: Статистика/отчёты поверх kpi_snapshots

### B.1 Charting

| Библиотека | Лицензия | Оценка |
|---|---|---|
| **Recharts** | MIT | **Уже в дашборде (3.10.1).** До ~5–10k точек — за глаза для витрины после агрегации |
| **uPlot** | MIT | Лучший перф (миллионы точек, canvas), императивный. Только если появится «сырая телеметрия 10Hz replay» — в backlog |
| **ECharts** | Apache-2.0 | Мощный, но ~1MB и второй chart-стек рядом с Recharts. Не тащить |
| **Chart.js** | MIT | Ничего не добавляет. Пропустить |
| Grafana embed | AGPL | **ЗАПРЕЩЁН** |

**Вердикт: Recharts** (нулевая новая зависимость).

### B.2 Агрегация

- **TimescaleDB — подтверждённо нельзя:** continuous aggregates только в Community Edition под **Timescale License (TSL)** — вне гейта; Apache-2-издание их **не содержит** (supabase/issues #12342). Плюс C-extension — в pglite не встаёт. Закрыто.
- **Вердикт: свои rollup-таблицы + инкрементальный job в Node, ~150 LOC SQL+TS:**
  - Миграция: `kpi_rollups(bucket_start timestamptz, bucket text check in ('hour','shift','day'), orders_completed, orders_per_hour_avg, avg_cycle_ms, utilization_avg, sample_count, primary key(bucket, bucket_start))`.
  - Job в `@tez/api` (рядом с recorder): раз в N минут `insert ... select date_trunc('hour', at), avg(...), count(*) from kpi_snapshots where at > $watermark group by 1 on conflict do update` — идемпотентно, watermark в служебной строке. `date_trunc` работает в pg и pglite.
  - **Смены** — не date_trunc: конфиг (`[{name:'A', start:'08:00', end:'20:00'}]`) в system-конфиге, бакет функцией в TS. Для UZ-клиентов смены = главный разрез.
  - On-the-fly для «последних 24ч» из kpi_snapshots; rollups для недель/месяцев. Cron не нужен — процесс вечно живёт.
  - Retention: kpi_snapshots агрессивно (есть механизм), kpi_rollups храним годами (24 строки/день).
- API: `GET /reports/kpi?bucket=hour|shift|day&from&to` (supervisor+), typebox-схемы.

### B.3 Экспорт

| Формат | Вердикт |
|---|---|
| **CSV** | **Делать сразу.** Свой сериализатор ~40 LOC (экранирование, `\r\n`, BOM для Excel/1C-кириллицы). `GET /reports/export.csv` стримом. CSV кормит 1C/Excel — главный сценарий UZ-клиента |
| **XLSX** | `exceljs` MIT, но **неактивен** (4.4.0 окт 2023, maintainer ушёл — issue #2969). **Отложить до запроса заказчика**; альтернативы: `write-excel-file` (MIT, активен, write-only), форк `@protobi/exceljs` |
| PDF | **Пропустить.** Печатная CSS-страница (`@media print`) во вкладке Reports — Ctrl+P даёт PDF бесплатно. Библиотеку — только под «автоматическая рассылка PDF» |

### B.4 Трудоёмкость

| Работа | dev-дни |
|---|---|
| Миграция kpi_rollups + rollup-job + watermark + тесты | 1 |
| Конфиг смен + shift-бакетирование | 0.5 |
| `GET /reports/kpi` + `GET /reports/export.csv` | 0.5 |
| Вкладка Reports (Recharts, смены-сравнение, print-CSS) | 1–1.5 |
| **Итого** | **3–3.5** |

**Риски:** (1) shift-бакеты через полночь (20:00–08:00) — тесты границы суток (в UZ DST нет — проще); (2) смена конфига смен задним числом — «rollup только вперёд», исторические бакеты фиксируются; (3) exceljs — pin версии; (4) утилизация — avg от avg некорректен при неравных sample_count → хранить `sample_count`, считать взвешенно.

---

## Сводка

| Дыра | Вердикт | Новые зависимости | Дни |
|---|---|---|---|
| Auth + RBAC + аудит + WS-auth | **С нуля** по учебнику Lucia | `argon2` (MIT), `@fastify/cookie` (MIT) | 3.5–4 |
| Статистика/отчёты | Rollup **с нуля** (Timescale CA = TSL); витрина на Recharts; CSV свой | нет | 3–3.5 |

Порядок: сначала Auth — аудит-лог сразу копит историю, и `GET /reports/*` рождается под `requireRole`.

Источники: lucia deprecation #1714, lucia-auth.com, better-auth Fastify docs + admin plugin, exceljs #2969/#2987, supabase #12342 (Timescale CA не в Apache-издании), tigerdata.com docs; LICENSE-файлы: better-auth, exceljs, uPlot, echarts, node-argon2, fastify-jwt, iron-session, fastify-auth, Chart.js, recharts.

# MiniPACS Portal — Clinton Medical

PACS-портал для solo-клиники в США. Хранение, просмотр, отправка DICOM-снимков + шаринг пациентам.

## Стек

- **Backend:** FastAPI + aiosqlite + httpx (прокси к Orthanc) — Python 3.14, venv в `backend/.venv`
- **Frontend:** React 19 + TypeScript + shadcn/ui + react-router-dom + axios + sonner (toasts) — в `frontend/`
- **PACS:** Orthanc (native install)
- **Viewer:** OHIF Viewer (embedded, DICOMweb)

## Текущий статус

Портал функционален. 12 страниц, 11 роутеров (~45 endpoints), OHIF viewer встроен. Demo data: 12 пациентов, 18 studies, 125 снимков.

### Что осталось до production:
1. **Серверная пагинация** — PatientsPage и StudiesPage грузят всё за раз (не масштабируется на 1000+ записей)
2. **Mobile responsive** — sidebar фиксирован 264px, нет мобильного меню
3. **nginx + HTTPS** — production deployment (systemd, TLS, firewall)
4. **Backup strategy** — SQLite + Orthanc storage scheduled backups

## Архитектура backend

```
backend/
  app/
    main.py          — FastAPI app, lifespan, router includes
    config.py         — Settings (pydantic-settings, .env)
    database.py       — aiosqlite setup
    create_user.py    — CLI для создания пользователей
    seed_demo.py      — генерация demo DICOM данных
    services/
      orthanc.py      — httpx.AsyncClient + asyncio.gather для параллельных запросов
    routers/          — 11 роутеров
      auth.py         — JWT + bcrypt + token_version + rate limiting
      patients.py     — прокси к Orthanc (404 handling)
      studies.py      — прокси к Orthanc + modality enrichment from series
      transfers.py    — PACS transfers + retry + study_id filter
      pacs_nodes.py   — CRUD + Orthanc modality registration + C-ECHO
      shares.py       — patient portal links CRUD
      settings.py     — key-value settings + /public endpoint (no auth)
      viewers.py      — external DICOM viewers CRUD
      audit.py        — immutable audit log + filtering
      users.py        — user management + token revocation
      stats.py        — dashboard aggregated stats
    models/
      transfers.py    — TransferRequest (study_id, pacs_node_id)
    middleware/
      audit.py        — async audit logging function
```

### Порты

| Сервис          | Порт  |
|-----------------|-------|
| Frontend (dev)  | 48925 |
| FastAPI         | 48920 |
| Orthanc HTTP    | 48923 |
| Orthanc DICOM   | 48924 |

### Ключевые паттерны backend

- Orthanc service — единый `httpx.AsyncClient`, `asyncio.gather` для параллельных запросов
- `_enrich_study_modalities()` — Orthanc не возвращает ModalitiesInStudy на study level, подтягиваем из series
- `NumberOfSeriesRelatedInstances` — fallback на `len(Instances[])` если тег пустой
- Orthanc 404 → наш 404 (не 500) — `get_patient`/`get_study` возвращают `None`
- Settings `/public` endpoint — без auth, для LoginPage и PatientPortalPage
- Transfer create возвращает объект с `status: "success"|"failed"` — фронт ПРОВЕРЯЕТ этот статус

## Архитектура frontend

```
frontend/src/
  lib/
    api.ts              — axios + interceptors + getErrorMessage() helper
    auth.ts             — AuthContext + useAuth hook
    dicom.ts            — ВСЕ DICOM утилиты (единый источник)
    utils.ts            — cn()
  providers/
    AuthProvider.tsx     — JWT auth + dynamic inactivity timeout из settings
  components/
    layout/
      AppLayout.tsx      — protected route wrapper
      Sidebar.tsx        — nav, dynamic clinic name, active state via startsWith
    ui/                  — shadcn/ui + confirm-dialog + skeleton
    ErrorBoundary.tsx    — React error boundary
    PageLoader.tsx       — full-page spinner
    TableSkeleton.tsx    — animated table loading
    CardSkeleton.tsx     — stat card loading
    viewer/
      OhifViewer.tsx     — OHIF iframe component
  pages/
    LoginPage.tsx        — clinic branding, HIPAA notice, rate limit handling
    DashboardPage.tsx    — /stats endpoint, welcome, quick actions
    PatientsPage.tsx     — search, table с onClick на TableRow
    PatientDetailPage.tsx — demographics, studies, transfers history, shares CRUD
    StudiesPage.tsx      — search, modality/date filters, pagination, onClick rows
    StudyDetailPage.tsx  — OHIF viewer, Send to PACS (4 states), Share with Patient
    TransfersPage.tsx    — clickable stat filters, auto-refresh, error dialogs, retry
    SharesPage.tsx       — create with success dialog, copy link, pagination
    PacsNodesPage.tsx    — CRUD, C-ECHO, clickable active toggle, ConfirmDialog
    AuditPage.tsx        — filters, shadcn Select, full CSV export
    SettingsPage.tsx     — clinic info, users, viewers with CRUD + toasts
    PatientPortalPage.tsx — OHIF viewer, clinic branding, study cards
    NotFoundPage.tsx     — 404 catch-all
```

### Ключевые паттерны frontend

- **`lib/dicom.ts`** — ВСЕ форматирование DICOM в одном месте. Не дублировать.
- **`getErrorMessage(err)`** — в `api.ts`, обрабатывает и строку, и массив validation errors от FastAPI
- **onClick на TableRow** — НЕ Link в каждой ячейке (ломает клики на Badge/code элементах)
- **Toast (sonner)** — на каждый CRUD: create/save/delete/revoke/send
- **ConfirmDialog** — на каждый destructive action (не browser `confirm()`)
- **Loading states** — PageLoader для detail pages, TableSkeleton для списков, CardSkeleton для dashboard
- **Transfer dialog** — 4 состояния: idle → sending (spinner) → success (checkmark) → error (human message + tech details)
- **Error messages** — `humanizeError()` переводит Orthanc ошибки в человеческий язык + collapsible tech details
- **AuthProvider** — spinner во время загрузки (не пустой экран), динамический auto_logout из settings
- **PatientPortalPage** — отдельный axios instance (без auth), clinic branding из `/settings/public`

## Команды

```bash
# Backend
cd backend && source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 48920 --reload

# Frontend
cd frontend && npm run dev

# Создание пользователя
cd backend && source .venv/bin/activate && python -m app.create_user

# Пересидить demo данные
cd backend && source .venv/bin/activate && python seed_demo.py

# TypeScript проверка
cd frontend && npx tsc --noEmit

# Production build
cd frontend && npx vite build
```

## Правила кода

### Обязательно:
- **Production-first** — никаких mock data, placeholder content
- **Real data** — всё работает с реальными данными из Orthanc
- **HIPAA compliance** — audit logging на каждое действие, encrypted transport
- **Existing patterns** — следовать паттернам описанным выше
- **DICOM formatting** — только через `lib/dicom.ts`, НИКОГДА не дублировать
- **Error handling** — всегда через `getErrorMessage()`, показывать человеческое сообщение + tech details
- **Toast feedback** — каждый save/create/delete/send показывает toast
- **Table rows** — onClick на TableRow, НЕ Link в каждой ячейке

### Никогда:
- browser `confirm()` — только ConfirmDialog
- "Loading..." текст — только PageLoader / TableSkeleton
- Дублирование утилит — всё в `lib/dicom.ts`
- Показывать raw DICOM форматы пользователю (DOE^JOHN, 20260411)
- Показывать raw Orthanc errors — humanizeError() + collapsible tech details
- useState после conditional return (нарушает React hooks rules)
- Загружать ВСЕ записи когда есть серверная фильтрация

## Рабочий процесс

### Superpowers skills — использовать когда подходит:
- **Brainstorming** — `superpowers:brainstorming` перед новой фичей или крупным изменением
- **Writing plans** — `superpowers:writing-plans` для многошаговых задач
- **Code review** — `superpowers:requesting-code-review` после крупных изменений
- **Verification** — `superpowers:verification-before-completion` перед финальным коммитом
- **Debugging** — `superpowers:systematic-debugging` при непонятных багах

Не обязательно для каждого мелкого фикса. Для баг-фиксов и точечных правок — делай сразу.

### Память (claude-mem)

Persistent memory: observations за все сессии. Используй:
1. `$CMEM` timeline — сканируй IDs по теме
2. `get_observations([IDs])` — детали (~300 токенов каждый)
3. `mem-search` — полнотекстовый поиск по прошлым сессиям
4. `smart_outline(file)` — структура файла без чтения тела

Порядок: memory → smart_outline → Read конкретных строк. Не читай целые файлы когда достаточно outline.

## Язык

Общение на русском. Технические термины и идентификаторы — на английском.

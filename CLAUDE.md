# MiniPACS — Clinton Medical

Полная PACS-экосистема для solo-клиники в США: приём DICOM-снимков с оборудования, хранение, просмотр, отправка в другие клиники, шаринг пациентам.

## Экосистема — 5 компонентов

```
[МРТ / КТ / Рентген]
       | DICOM C-STORE (TLS)
       v
[Orthanc PACS :48924 DICOM / :48923 HTTP]
       |
       | REST API + DICOMweb
       v
[FastAPI Backend :48922]
       |
       | JSON REST API
       v
[React Frontend + OHIF Viewer]
       |
[nginx :48920 HTTP → :48921 HTTPS]
    /         → React (static build)
    /api/     → FastAPI
    /dicom-web/ → Orthanc DICOMweb
    /ohif/    → OHIF Viewer (static build)
```

### 1. Orthanc PACS (`orthanc/`)
- **orthanc.json** — конфигурация: порты, TLS, DICOMweb, Authorization, Transfers
- AE Title: `MINIPACS`, DICOM порт 48924, HTTP порт 48923
- Плагины: DICOMweb, Authorization, Transfers
- Auth: basic auth (orthanc:password), RemoteAccessAllowed=false
- DICOMweb endpoint: `/dicom-web/` — используется OHIF и фронтом
- Modalities хранятся в БД (DicomModalitiesInDatabase=true) — синхронизируются из бэкенда

### 2. OHIF Viewer (`ohif-source/`, `ohif-dist/`, `ohif-config/`)
- **ohif-source/** — исходники OHIF (не трогаем, только билдим)
- **ohif-dist/** — собранный OHIF, отдаётся nginx на `/ohif/`
- **ohif-config/minipacs.js** — конфигурация: DICOMweb endpoint, white-labeling (логотип "M", "MiniPACS Viewer")
- Конфиг копируется в `ohif-dist/app-config.js` после билда
- `showStudyList: false` — список studies скрыт, viewer открывается по прямой ссылке
- DataSource: Orthanc через `/dicom-web/`

### 3. FastAPI Backend (`backend/`)
```
backend/
  app/
    main.py          — FastAPI app, lifespan, router includes
    config.py         — Settings (pydantic-settings, .env)
    database.py       — aiosqlite setup
    create_user.py    — CLI для создания пользователей
    services/
      orthanc.py      — httpx.AsyncClient + asyncio.gather для параллельных запросов
    routers/          — 11 роутеров
      auth.py         — JWT + bcrypt + token_version + rate limiting
      patients.py     — прокси к Orthanc (404 handling)
      studies.py      — прокси + modality enrichment from series
      transfers.py    — PACS transfers + retry + study_id filter
      pacs_nodes.py   — CRUD + Orthanc modality sync + C-ECHO
      shares.py       — patient portal links CRUD
      settings.py     — key-value settings + /public (no auth)
      viewers.py      — external DICOM viewers CRUD
      audit.py        — immutable audit log + filtering
      users.py        — user management + token revocation
      stats.py        — dashboard aggregated stats
    models/
      transfers.py    — TransferRequest (study_id, pacs_node_id)
    middleware/
      audit.py        — async audit logging function
  seed_demo.py        — генерация demo DICOM данных (12 пациентов, 18 studies, 125 снимков)
```

### 4. React Frontend (`frontend/`)
```
frontend/src/
  lib/
    api.ts              — axios + interceptors + getErrorMessage()
    auth.ts             — AuthContext + useAuth hook
    dicom.ts            — ВСЕ DICOM утилиты (единый источник)
    utils.ts            — cn()
  providers/
    AuthProvider.tsx     — JWT auth + dynamic inactivity timeout
  components/
    layout/Sidebar.tsx   — nav, dynamic clinic name, active via startsWith
    ui/                  — shadcn/ui + confirm-dialog + skeleton
    ErrorBoundary.tsx, PageLoader.tsx, TableSkeleton.tsx, CardSkeleton.tsx
    viewer/OhifViewer.tsx — OHIF iframe
  pages/
    LoginPage, DashboardPage, PatientsPage, PatientDetailPage,
    StudiesPage, StudyDetailPage, TransfersPage, SharesPage,
    PacsNodesPage, AuditPage, SettingsPage, PatientPortalPage, NotFoundPage
```

### 5. nginx (`nginx/`)
- **nginx.conf** — reverse proxy, HTTPS, security headers
- HTTP :48920 → redirect → HTTPS :48921
- TLS 1.2+, HSTS, X-Frame-Options, CSP
- Проксирует `/api/` → FastAPI, `/dicom-web/` → Orthanc (с basic auth header)
- Статика: `/` → React dist, `/ohif/` → OHIF dist

### Скрипты (`scripts/`)
- **start-all.sh** — запуск Orthanc + FastAPI + nginx одной командой
- **generate-certs.sh** — генерация self-signed TLS сертификатов

## Текущий статус

Портал функционален. 13 страниц, 11 роутеров (~45 endpoints), OHIF viewer встроен.

### Что осталось до production:
1. **Серверная пагинация** — Patients/Studies грузят всё за раз
2. **Mobile responsive** — нет мобильного меню
3. **Production deployment** — systemd units, firewall rules, real TLS certs
4. **Backup strategy** — SQLite + Orthanc storage scheduled backups
5. **OHIF rebuild** — white-label с "Clinton Medical" вместо "MiniPACS Viewer"

## Порты

| Сервис           | Порт  | Назначение          |
|------------------|-------|---------------------|
| nginx HTTP       | 48920 | → redirect HTTPS    |
| nginx HTTPS      | 48921 | Entry point         |
| FastAPI          | 48922 | Backend API         |
| Orthanc HTTP     | 48923 | REST API + DICOMweb |
| Orthanc DICOM    | 48924 | C-STORE / C-ECHO    |
| Frontend dev     | 48925 | Vite dev server     |

## Команды

```bash
# === Production (все сервисы) ===
./scripts/start-all.sh

# === Development ===
# Backend
cd backend && source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 48920 --reload

# Frontend
cd frontend && npm run dev

# Создание пользователя
cd backend && source .venv/bin/activate && python -m app.create_user

# Demo данные (удаляет старые, создаёт новые)
cd backend && source .venv/bin/activate && python seed_demo.py

# TypeScript проверка
cd frontend && npx tsc --noEmit

# Production build frontend
cd frontend && npx vite build

# OHIF rebuild с кастомным конфигом
cd ohif-source && yarn build
cp -r platform/app/dist/* ../ohif-dist/
cp ../ohif-config/minipacs.js ../ohif-dist/app-config.js
```

## Ключевые паттерны backend

- Orthanc service — единый `httpx.AsyncClient`, `asyncio.gather` для параллельных запросов
- `_enrich_study_modalities()` — Orthanc не отдаёт ModalitiesInStudy на study level, подтягиваем из series
- `NumberOfSeriesRelatedInstances` — fallback на `len(Instances[])` если тег пустой
- Orthanc 404 → наш 404 (не 500)
- Settings `/public` — без auth, для LoginPage и PatientPortalPage
- Transfer create возвращает `status: "success"|"failed"` — фронт ПРОВЕРЯЕТ
- PACS nodes — при CRUD автоматически синхронизируют modalities в Orthanc

## Ключевые паттерны frontend

- **`lib/dicom.ts`** — ВСЕ DICOM форматирование. НЕ дублировать.
- **`getErrorMessage(err)`** — обрабатывает строку и массив validation errors от FastAPI
- **onClick на TableRow** — НЕ Link в каждой ячейке
- **Toast (sonner)** — на каждый CRUD action
- **ConfirmDialog** — на каждый destructive action (не browser `confirm()`)
- **Loading states** — PageLoader / TableSkeleton / CardSkeleton (не "Loading..." текст)
- **Transfer dialog** — 4 состояния: idle → sending → success → error
- **`humanizeError()`** — переводит Orthanc ошибки в человеческий язык + collapsible tech details
- **PatientPortalPage** — отдельный axios без auth, clinic branding из `/settings/public`

## Правила

### Обязательно:
- Production-first — никаких mock data
- HIPAA compliance — audit logging на каждое действие
- Все DICOM имена через `formatDicomName()` (DOE^JOHN → John Doe)
- Error handling через `getErrorMessage()` + человеческое сообщение
- Toast на каждый save/create/delete/send
- useState/useEffect ДО любого conditional return

### Никогда:
- browser `confirm()` → только ConfirmDialog
- "Loading..." текст → PageLoader / TableSkeleton
- Дублирование DICOM утилит → только `lib/dicom.ts`
- Raw DICOM формат пользователю
- Raw Orthanc error → humanizeError()
- Загрузка ВСЕХ записей без серверной фильтрации
- Link в каждой TableCell → onClick на TableRow

## Рабочий процесс

### Superpowers skills:
- `superpowers:brainstorming` — перед новой фичей или крупным изменением
- `superpowers:writing-plans` — для многошаговых задач
- `superpowers:requesting-code-review` — после крупных изменений
- `superpowers:verification-before-completion` — перед финальным коммитом
- `superpowers:systematic-debugging` — при непонятных багах

Для мелких фиксов — делай сразу без skills.

### Память (claude-mem):
1. `$CMEM` timeline → `get_observations([IDs])` → `mem-search` → `smart_outline` → Read
2. Не читай целые файлы когда достаточно outline

## Язык

Общение на русском. Технические термины и идентификаторы — на английском.

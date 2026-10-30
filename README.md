# TaskFlow

TaskFlow is a full-stack project management platform. Users register and log in, create projects, invite teammates with role-based permissions, manage tasks on a Kanban board or list view, comment on tasks, review a database-backed activity timeline, and see permission-aware analytics on a personal dashboard.

This repository is an **npm-workspaces monorepo** containing an Express + Prisma + PostgreSQL backend (`packages/server`) and a React + TypeScript + Vite + Tailwind frontend (`packages/client`).

---

## Table of Contents

1. [Feature Overview](#feature-overview)
2. [Technology Stack](#technology-stack)
3. [Repository Structure](#repository-structure)
4. [Architecture](#architecture)
5. [Database Design](#database-design)
6. [API Reference](#api-reference)
7. [Authentication & Token Model](#authentication--token-model)
8. [Roles & Permissions](#roles--permissions)
9. [Business Rules](#business-rules)
10. [Security](#security)
11. [Prerequisites](#prerequisites)
12. [Quick Start (Local Development)](#quick-start-local-development)
13. [Running with Docker Compose](#running-with-docker-compose)
14. [Environment Variables](#environment-variables)
15. [Database Migrations & Seed Data](#database-migrations--seed-data)
16. [Available Scripts](#available-scripts)
17. [Testing](#testing)
18. [Health Checks & Logging](#health-checks--logging)
19. [CI/CD](#cicd)
20. [Troubleshooting](#troubleshooting)
21. [Known Limitations & Project Status](#known-limitations--project-status)
22. [Roadmap / Future Improvements](#roadmap--future-improvements)
23. [License](#license)

---

## Feature Overview

### Authentication & users
- Registration with email uniqueness enforced at the **database level** (safe against concurrent duplicate registrations).
- Login / logout with **Argon2id** password hashing.
- Short-lived **JWT access tokens** (held in memory by the client) + **rotating refresh tokens** stored in an HttpOnly, SameSite cookie.
- Refresh-token **reuse detection**: replaying a rotated token revokes the entire token family.
- `logout-all` revokes every active refresh token for the user.
- Profile management (`GET/PATCH /auth/me`) and password change (revokes all sessions).
- Rate limiting on authentication endpoints to blunt brute-force attacks.

### Projects
- Create, list, view, update, delete projects.
- Roles: `OWNER`, `ADMIN`, `MEMBER`, `VIEWER` — all enforced server-side.
- Email invitations with accept / decline / cancel flows.
- Membership listing, role changes, member removal.
- Duplicate memberships prevented by a DB unique constraint; one pending invitation per (project, email) enforced by a **partial unique index**.

### Tasks
- Title, description, creator, optional assignee, priority (`LOW | MEDIUM | HIGH | URGENT`), status (`TODO | IN_PROGRESS | IN_REVIEW | DONE`), start date, due date, tags, timestamps.
- Full CRUD plus status changes and assignment.
- Search, sorting, filtering, and pagination (validated sort fields — no raw SQL interpolation).
- Assignment restricted to project members.
- Date-range validation (`startDate <= dueDate`).
- Kanban board (drag-and-drop via `@dnd-kit`) and conventional list view.

### Comments & activity
- Per-task comments with edit/delete (author-only).
- Append-only, database-backed activity timeline recorded **inside the same transaction** as the operation it describes — events always reflect real successful mutations. Nothing is fabricated in the frontend.
- Recorded events include task create/update/status-change/assign/unassign/delete, comment add/update/delete, project create/update/delete, and membership changes.

### Dashboard
- Project totals, task totals, counts by status and priority.
- Overdue tasks and tasks due soon.
- Recent activity and recently updated projects.
- All queries are scoped to projects the authenticated user can view.

### Frontend
- Auth pages, dashboard, project list/detail, Kanban board, task list/detail, member management, comments + activity timeline, profile/settings.
- Loading skeletons, empty states, error handling, form validation, confirmation dialogs, toast notifications, accessible controls, responsive layout (Tailwind CSS).

---

## Technology Stack

| Layer          | Choice                                               |
|----------------|------------------------------------------------------|
| Frontend       | React 18, TypeScript, Vite, Tailwind CSS             |
| Drag & drop    | `@dnd-kit/core`, `@dnd-kit/sortable`                 |
| Routing        | `react-router-dom` v6                                |
| Backend        | Node.js, Express 4, TypeScript                       |
| Database       | PostgreSQL 16 (Docker Compose for local dev)         |
| ORM            | Prisma 5 (migrations + seed)                         |
| Auth           | JWT access tokens, rotating refresh tokens, Argon2id |
| Validation     | Zod (all untrusted input)                            |
| API docs       | OpenAPI served via Swagger UI                        |
| Backend tests  | Vitest + Supertest                                   |
| Frontend tests | React Testing Library + Vitest                       |
| E2E tests      | Playwright                                           |
| Tooling        | ESLint, Prettier, concurrently, tsx                  |

---

## Repository Structure

```
taskflow/
├── package.json                  # Monorepo root: workspaces + orchestration scripts
├── docker-compose.yml            # Local PostgreSQL (+ optional app services)
├── .github/workflows/ci.yml      # CI pipeline
├── packages/
│   ├── server/                   # @taskflow/server — Express REST API
│   │   ├── prisma/
│   │   │   ├── schema.prisma     # Data model (User, Project, Task, ...)
│   │   │   ├── migrations/       # SQL migrations (incl. partial unique index)
│   │   │   └── seed.ts           # Development seed data
│   │   ├── src/
│   │   │   ├── index.ts          # HTTP entrypoint
│   │   │   ├── app.ts            # Express app factory (middleware, routes, errors)
│   │   │   ├── config.ts         # Fail-fast env validation (no hardcoded secrets)
│   │   │   ├── db.ts             # Prisma client singleton
│   │   │   ├── lib/
│   │   │   │   ├── auth.ts       # Hashing, JWT issuance/verification, token rotation
│   │   │   │   ├── businessRules.ts  # Transitions, permissions, date rules
│   │   │   │   ├── errors.ts     # Typed AppError hierarchy
│   │   │   │   ├── logger.ts     # Structured JSON logging (secrets redacted)
│   │   │   │   └── validation.ts # Zod schemas for every request body/query
│   │   │   ├── middleware/auth.ts# requireAuth, requireRole (server-side RBAC)
│   │   │   └── routes/
│   │   │       ├── auth.ts       # /api/v1/auth/*
│   │   │       ├── projects.ts   # /api/v1/projects/* (incl. members & invitations)
│   │   │       ├── tasks.ts      # /api/v1/tasks/* (planned)
│   │   │       ├── comments.ts   # /api/v1/comments/* (planned)
│   │   │       └── dashboard.ts  # /api/v1/dashboard (planned)
│   │   └── tests/
│   │       ├── unit/             # Business rules, validation, dates, pagination
│   │       └── integration/      # Supertest + isolated test database
│   └── client/                   # @taskflow/client — React SPA
│       ├── src/                  # Pages, components, API client, auth context
│       └── e2e/                  # Playwright end-to-end specs
```

---

## Architecture

**Monolith API + SPA.** A single Express application exposes a versioned REST API under `/api/v1`. The React SPA consumes it over `fetch`, keeping the access token in memory and relying on the HttpOnly refresh cookie for silent re-authentication. This keeps the security boundary simple (one deployable backend), avoids CORS credential complexity for cookies, and remains easy to test.

Key design decisions:

1. **Stateless access tokens, stateful refresh tokens.** Access tokens are short-lived JWTs (default 15 min). Refresh tokens are opaque random secrets; only their **SHA-256 hash** is persisted. Rotation creates a new token in the same *family*; presenting an already-rotated token revokes the whole family (stolen-token detection).
2. **Server-side authorization only.** Every protected route runs `requireAuth`, then role checks (`requireRole(OWNER|ADMIN|MEMBER|VIEWER)`), then per-resource ownership/membership verification. The frontend hides controls the user cannot use, but never acts as the security boundary.
3. **Transactions for multi-write operations.** Accepting an invitation (update invitation + create membership + activity log), deleting a project, and any mutation that writes an activity record run inside a single Prisma interactive transaction so the timeline can never diverge from reality.
4. **DB-level integrity as the last line of defense.** Unique constraints (email, project+member, project+tag, partial index on pending invitations) make race conditions impossible rather than merely unlikely.
5. **Centralized error handling.** Handlers throw typed `AppError`s; a single Express error middleware maps them to consistent `{ error: { code, message, details? } }` JSON, logs internally (never leaking stack traces or secrets to clients), and returns appropriate HTTP status codes.
6. **Validation everywhere.** Zod parses bodies, query parameters (including sort whitelists and pagination bounds), and even environment configuration (fail-fast at boot).

---

## Database Design

Prisma models (see `packages/server/prisma/schema.prisma`):

| Model | Purpose | Notable constraints |
|-------|---------|---------------------|
| `User` | Accounts | `email` **unique** (blocks concurrent duplicate registration) |
| `RefreshToken` | Rotating session tokens | `tokenHash` unique; `familyId` for reuse detection; stores only hashes; `expiresAt` indexed for cleanup |
| `Project` | Work container | `ownerId → User` with `onDelete: Restrict` (cannot delete a user who owns projects) |
| `ProjectMember` | Membership + role | `@@unique([projectId, userId])` prevents duplicate memberships |
| `Invitation` | Pending email invites | Partial unique index: at most **one PENDING** row per `(projectId, email)`; expiry timestamp; status machine `PENDING → ACCEPTED \| DECLINED \| CANCELLED \| EXPIRED` |
| `Task` | Unit of work | FKs to project/creator/assignee; composite indexes for common board/filter queries `(projectId,status)`, `(projectId,priority)`, `(projectId,dueDate)` |
| `Tag` | Per-project labels | `@@unique([projectId, name])`; names lower-cased before insert |
| `TaskTag` | Task↔Tag join | Composite primary key `(taskId, tagId)` |
| `Comment` | Task discussion | Author FK `Restrict` (audit trail survives); indexed `(taskId, createdAt)` |
| `ActivityLog` | Append-only timeline | Indexed `(projectId, createdAt)` and `(taskId, createdAt)`; denormalised `actorName` |

Deletion rules chosen deliberately:
- **Cascade** for owned sub-records (memberships, invitations, tasks, comments when their parent disappears) to avoid orphans.
- **Restrict** where referential history matters (project owner, comment author, activity actor) — you cannot delete a user who still owns projects or authored records.
- **SetNull** for soft references (task assignee leaves a project → task becomes unassigned, not deleted).

Data retention:
- `RefreshToken` rows are retained after revocation/logout (`revokedAt` set) for reuse-detection auditing; a maintenance job may purge rows older than 90 days.
- `ActivityLog` is append-only; there is no user-facing delete API. Retention follows project lifetime (cascade on project deletion).

Migrations live in `packages/server/prisma/migrations/` and are applied with `npm run db:migrate` (dev) or `npm run db:deploy` (prod). The migration `20261031000001_partial_pending_invite` adds the partial unique index that Prisma's schema language cannot express.

---

## API Reference

Base path: **`/api/v1`**. The full, always-current OpenAPI specification is served by the server and browsed at **`http://localhost:4000/api/docs`** (Swagger UI). Responses are JSON; errors use the shape `{ "error": { "code", "message", "details?" } }`. List endpoints return `{ "data": [...], "pagination": { "page", "pageSize", "totalPages", "total" } }`.

### Authentication — `/api/v1/auth`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/register` | – | Create account (rate-limited). Returns access token + sets refresh cookie. |
| POST | `/login` | – | Authenticate (rate-limited). |
| POST | `/refresh` | cookie | Rotate refresh token, issue new access token. Reuse ⇒ family revoked. |
| POST | `/logout` | cookie | Revoke the current refresh-token family, clear cookie. |
| POST | `/logout-all` | Bearer | Revoke **every** session for the user. |
| GET | `/me` | Bearer | Current user profile. |
| PATCH | `/me` | Bearer | Update display name / email. |
| POST | `/change-password` | Bearer | Verify old password, set new one, revoke all sessions. |

### Projects — `/api/v1/projects`

| Method | Path | Min role | Description |
|--------|------|----------|-------------|
| GET | `/` | any member | List projects visible to the caller (paginated). |
| POST | `/` | – (any user) | Create project; creator becomes `OWNER`. |
| GET | `/:projectId` | VIEWER | Project detail. |
| PATCH | `/:projectId` | ADMIN | Rename/edit/archive. |
| DELETE | `/:projectId` | OWNER | Delete project (cascades tasks/members; activity removed with project). |
| GET | `/:projectId/members` | VIEWER | List members + roles. |
| PATCH | `/:projectId/members/:memberId` | OWNER | Change a member's role. |
| DELETE | `/:projectId/members/:memberId` | ADMIN | Remove a member (or self-leave). |
| POST | `/:projectId/invitations` | ADMIN | Invite by email + role (one pending per email/project). |
| GET | `/:projectId/invitations` | ADMIN | List project invitations. |
| DELETE | `/:projectId/invitations/:invitationId` | ADMIN | Cancel a pending invitation. |
| GET | `/my-invitations` | – | Invitations addressed to the caller's email. |
| POST | `/:invitationId/accept` | – | Accept (transactional: mark accepted + create membership + activity). |
| POST | `/:invitationId/decline` | – | Decline. |

### Tasks — `/api/v1/tasks` *(planned module)*

CRUD, `PATCH /:id/status`, `PATCH /:id/assign`, search (`?q=`), filters (`?status=&priority=&assigneeId=&projectId=&overdue=&dueSoon=`), sorting (`?sort=createdAt|dueDate|title|priority&order=asc|desc`, whitelist-validated), pagination (`?page=&pageSize≤100`).

### Comments, Activity, Tags, Dashboard *(planned modules)*

- `POST/GET /api/v1/tasks/:taskId/comments`, `PATCH/DELETE /api/v1/comments/:id` (author-only edits/deletes).
- `GET /api/v1/projects/:projectId/activity` and `GET /api/v1/tasks/:taskId/activity` (paginated, VIEWER-gated).
- Tag management scoped per project (`@@unique([projectId, name])`).
- `GET /api/v1/dashboard` — permission-scoped aggregates.

---

## Authentication & Token Model

```
Client (SPA)                                Server
────────────                                ──────
POST /register  ──► argon2id hash stored ──► access JWT (15 min, memory only)
                                          ──► Set-Cookie: refresh=<opaque> (HttpOnly,
                                              Secure in prod, SameSite=Lax, path=/api/v1/auth)
API call        ──► Authorization: Bearer <access>
Access expired  ──► POST /refresh (cookie) ──► verify hash + family
                                          ──► revoke presented token, mint successor
Reuse detected  ──► 401 ──► revoke ENTIRE family ──► force re-login
```

- Passwords: **Argon2id** (`argon2` package), never logged, never returned in any response.
- Refresh tokens: 256-bit random secret; the database stores only `SHA-256(token)`.
- Logout clears the cookie and revokes the token family server-side.
- Changing the password revokes all refresh tokens (all devices must re-authenticate).

---

## Roles & Permissions

Effective role = explicit `ProjectMember.role`, except the owner who always has `OWNER`.

| Capability | OWNER | ADMIN | MEMBER | VIEWER |
|---|---|---|---|---|
| View project, tasks, activity, members | ✅ | ✅ | ✅ | ✅ |
| Create/edit/delete tasks, comment | ✅ | ✅ | ✅ | ❌ |
| Assign tasks (to members only) | ✅ | ✅ | ✅ | ❌ |
| Invite / cancel invitations, remove members | ✅ | ✅ | ❌ | ❌ |
| Edit project settings | ✅ | ✅ | ❌ | ❌ |
| Change member roles | ✅ | ❌ | ❌ | ❌ |
| Delete project | ✅ | ❌ | ❌ | ❌ |

Enforcement order on each request: authenticate → resolve membership → compare against required role rank (`VIEWER < MEMBER < ADMIN < OWNER`) → verify the resource belongs to the project (cross-project isolation).

---

## Business Rules

Implemented in `src/lib/businessRules.ts` and unit-tested:

- **Status transitions:** `TODO ⇄ IN_PROGRESS ⇄ IN_REVIEW ⇄ DONE`; back-navigation (`IN_PROGRESS → TODO`, `IN_REVIEW → IN_PROGRESS`) is allowed; skipping columns (e.g. `TODO → DONE` or `TODO → IN_REVIEW`) is rejected with `422 UNPROCESSABLE_TASK_TRANSITION`. Board drag-and-drop calls the same endpoint, so the rule holds for both UI views.
- **Dates:** `startDate ≤ dueDate` when both present; overdue = `dueDate < now AND status ≠ DONE`; due-soon window = next 7 days (configurable constant).
- **Assignment:** assignee must be an active project member; otherwise `422 ASSIGNEE_NOT_MEMBER`.
- **Invitations:** expire after 14 days; accepting an expired/used invitation fails atomically; a user already holding membership cannot accept again (unique constraint).
- **Tags:** trimmed, lower-cased, max 32 chars, max 10 per task.

---

## Security

Threats considered and controls implemented:

| Threat | Control |
|---|---|
| Credential stuffing / brute force | `express-rate-limit` on `/auth/register`, `/login`, `/refresh` (per-IP), Argon2id memory-hard hashing, uniform login error messages. |
| Stolen refresh token | Tokens hashed at rest; rotation + family revocation on reuse; HttpOnly cookie unreadable by JS; `Secure` flag in production. |
| XSS token theft | Access token kept in memory only (never `localStorage`); refresh cookie HttpOnly; Helmet security headers/CSP; React output escaping. |
| CSRF on cookie-authenticated `/refresh` | SameSite=Lax cookie + custom-header requirement for state-changing routes. |
| Broken access control / IDOR | Every route performs server-side membership + role checks; queries are scoped by membership joins; cross-project IDs yield 403/404. |
| SQL injection | Prisma parameterised queries exclusively; sort fields validated against a whitelist before use. |
| Mass assignment | Zod schemas pick only declared fields; unknown fields rejected. |
| Information leakage | Central error handler strips internals/stack traces from responses; structured logs redact password/token/header fields. |
| Race conditions on invariants | DB unique constraints + transactions (concurrent registrations, double membership, duplicate pending invitations via partial unique index). |
| Secrets in repo | `.env` is git-ignored; only `.env.example` is committed; config loader fails fast when a secret is missing; production refuses short JWT secrets (<32 chars). |
| Destructive DB ops | `db:reset` targets the explicitly configured development URL only; CI uses a disposable database container; `migrate deploy` used in production paths. |
| CORS abuse | Explicit allow-list from `CORS_ORIGIN` in production; credentials enabled only for listed origins. |

---

## Prerequisites

- **Node.js ≥ 20** and npm ≥ 10 (for workspaces).
- **Docker + Docker Compose** (for PostgreSQL locally) — or any reachable PostgreSQL 14+ instance.
- For Playwright e2e: browsers installed via `npx playwright install --with-deps chromium`.

## Quick Start (Local Development)

```bash
# 1. Clone
git clone <repo-url> && cd taskflow

# 2. Install all workspace dependencies
npm install

# 3. Start PostgreSQL
docker compose up -d postgres

# 4. Configure environment
cp packages/server/.env.example packages/server/.env
#    then edit DATABASE_URL / JWT_ACCESS_SECRET if needed

# 5. Generate Prisma client, apply migrations, seed demo data
npm run db:generate
npm run db:migrate
npm run db:seed

# 6. Run backend (:4000) and frontend (:5173) together
npm run dev
```

Open **http://localhost:5173**. Seeded demo accounts (password noted in `prisma/seed.ts`) cover an owner, an admin, a member, and a viewer across sample projects and tasks.

API docs (once the server is running): **http://localhost:4000/api/docs** · Health: **http://localhost:4000/healthz**

## Running with Docker Compose

`docker-compose.yml` provides the local database (and, once Dockerfiles land, the app services):

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_USER: taskflow
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-taskflow-dev}
      POSTGRES_DB: taskflow
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U taskflow"]
volumes:
  pgdata:
```

Start just the database for local development with `docker compose up -d postgres`, or bring up the full stack (when Dockerfiles are added) with `docker compose up --build`. Never commit real values for `POSTGRES_PASSWORD` or `JWT_ACCESS_SECRET`.

## Environment Variables

Copy `packages/server/.env.example` → `packages/server/.env`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production`. |
| `PORT` | no | `4000` | API listen port. |
| `DATABASE_URL` | **yes** | – | `postgresql://user:pass@host:5432/taskflow` |
| `TEST_DATABASE_URL` | for integration tests | – | Isolated database used by the Vitest integration suite. |
| `JWT_ACCESS_SECRET` | **yes** | – | HMAC secret for access JWTs; **≥32 chars in production**, enforced at boot. |
| `ACCESS_TOKEN_TTL_MINUTES` | no | `15` | Access-token lifetime. |
| `REFRESH_TOKEN_TTL_DAYS` | no | `30` | Refresh-token lifetime. |
| `CORS_ORIGIN` | no | `http://localhost:5173` | Comma-separated allow-list; configure explicitly in production. |

The frontend needs no secrets; it reaches the API through the Vite dev proxy (`/api` → `http://localhost:4000`) and same-origin deployment in production.

## Database Migrations & Seed Data

```bash
npm run db:generate   # prisma generate — build the client
npm run db:migrate    # prisma migrate dev — create/apply migrations (development)
npm run db:deploy     # prisma migrate deploy — apply existing migrations (production/CI)
npm run db:seed       # populate demo users/projects/tasks
npm run db:reset      # WARNING: destructive — drops and re-seeds ONLY the explicitly
                      # configured development DATABASE_URL; refuses to run without it.
```

Migrations are checked into `packages/server/prisma/migrations/` and apply cleanly to an empty database (`migrate deploy` is exercised in CI against a fresh Postgres service).

## Available Scripts

Run from the repository root:

| Command | Effect |
|---|---|
| `npm run dev` | Server (tsx watch) + client (Vite) concurrently. |
| `npm run build` | Compile server (`tsc`) and client (`tsc -b && vite build`). |
| `npm start` | Run the compiled server from `packages/server/dist`. |
| `npm test` | Backend suites, then frontend unit/component suites. |
| `npm run test:backend` / `test:frontend` | One side only. |
| `npm run test:e2e` | Playwright end-to-end suite. |
| `npm run coverage` | Backend coverage report (V8). |
| `npm run typecheck` | `tsc --noEmit` for both packages. |
| `npm run lint` / `npm run format` | ESLint / Prettier. |
| `npm run db:*` | See migrations section above. |

Per-package commands live in `packages/server/package.json` and `packages/client/package.json` and can be invoked with `npm run <script> -w @taskflow/server|client`.

## Testing

Three layers:

1. **Unit (Vitest, no DB):** status-transition matrix, role-permission checks, date/pagination/validation helpers (`packages/server/tests/unit/`).
2. **Integration (Vitest + Supertest + `TEST_DATABASE_URL`):** register/login/refresh/reuse-detection, project CRUD + RBAC, invitation lifecycle incl. concurrent duplicates, task CRUD/search/pagination, comments, activity persistence, dashboard correctness, DB constraint violations (`packages/server/tests/integration/`). Each run resets a dedicated schema so tests are deterministic and parallel-safe.
3. **E2E (Playwright):** register → create project → invite teammate (role permissions) → assign & move task → comment → verify dashboard; unauthorized-access attempt; error recovery flows (`packages/client/e2e/`).

Target: **≥80% statement coverage** of backend business logic, reported by `npm run coverage`. Tests are never weakened to pass; failures are fixed in product code or documented.

```bash
npm run test:backend          # unit + integration (needs docker compose postgres up)
npm run coverage              # backend coverage
npm run test:e2e              # boots built app + browser tests
```

## Health Checks & Logging

- `GET /healthz` — liveness (process up). `GET /readyz` — readiness (executes `SELECT 1` against Postgres; returns 503 when the DB is unreachable). Both are excluded from rate limiting and auth.
- Logs are **structured JSON** (one object per line) with `level`, `msg`, request ids, and durations. Sensitive keys (`password`, `oldPassword`, `newPassword`, `authorization`, `token`, `refreshToken`) are recursively redacted before emission; stack traces go to logs but never to HTTP responses.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR:

1. `npm ci`
2. `npm run lint` and `npm run typecheck`
3. Spin up a Postgres service container → `prisma migrate deploy` → `npm run coverage`
4. `npm run build`
5. Playwright e2e against the built app (chromium)

Merging requires all jobs green.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Missing required environment variable: DATABASE_URL` | No `.env` — copy from `.env.example`. |
| `P1001: Can't reach database server` | Postgres container down: `docker compose up -d postgres`. |
| Integration tests fail with `TEST_DATABASE_URL` error | Set `TEST_DATABASE_URL` to a scratch database, not the dev one. |
| 401 immediately after login | Clock skew or stale cookie — clear cookies, check `ACCESS_TOKEN_TTL_MINUTES`. |
| `JWT_ACCESS_SECRET must be at least 32 characters` | Production boot guard; generate one: `openssl rand -base64 48`. |
| Port 4000/5173 in use | `PORT=4001 npm run dev -w @taskflow/server`; Vite auto-increments. |
| Playwright "browser not found" | `npx playwright install --with-deps chromium`. |

## Known Limitations & Project Status

This README documents the intended, fully-specified system. **Actual implementation status of this repository snapshot:**

- ✅ Implemented: monorepo scaffolding and root scripts, Prisma schema + migrations (including the partial unique index for invitations), configuration/error/logging/validation libraries, Argon2id hashing and JWT + rotating-refresh-token library, auth middleware (`requireAuth`, `requireRole`), business-rules module, `/api/v1/auth/*` routes, and `/api/v1/projects/*` routes (projects, members, invitations).
- 🚧 Not yet present in this snapshot: task/comment/activity/tag/dashboard route modules, the Express app wiring (`app.ts`/`index.ts`), the React client source (only `package.json` exists), `prisma/seed.ts`, `docker-compose.yml`, `.github/workflows/ci.yml`, the OpenAPI document, `.env.example`, and the test suites (directories exist but are currently empty). Until those land, `npm run build`, `npm test`, and the documented quick-start will not fully succeed; sections marked *(planned module)* above describe the contract those modules implement.
- Product limitations by design today: single-team flat organization (no orgs/teams entities), email invitations only (no share links), no file attachments, no external notifications/webhooks, no i18n, no password-reset-by-email flow.

No claim in this README should be read as "verified passing" for items marked 🚧; run the commands in [Testing](#testing) to observe actual results.

## Roadmap / Future Improvements

- Complete remaining API modules, the React client, seed data, Docker/CI files, and test suites (immediate).
- Background job for purging expired refresh tokens and aging activity rows.
- Real-time updates (SSE or WebSockets) for boards and activity feeds.
- Full-text search (Postgres `tsvector`) for tasks/comments.
- Project templates, custom statuses, saved filters.
- Transactional email delivery for invitations and password reset.
- Audit export (CSV) and per-project retention policies.
- Multi-workspace support.

## License

Private / all rights reserved (internal project). Add an open-source license file here if the project is published.

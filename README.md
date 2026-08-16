# Elimu Smart

WhatsApp-first school communication SaaS for Kenyan private schools, CBC-aligned
(Grades 1-12). Forked from [CellConnect](https://github.com/akyturiySolutions/cellconnect)
— see `docs/PROJECT_OVERVIEW.md` etc. (carried over from CellConnect, not yet
re-written for this project) for the underlying architecture.

## What's been done in this fork

- **Roles simplified to two**: `admin` (full access — folds in what CellConnect
  split into `secretary` + `pastor`, plus headteacher powers: lesson-plan
  approval, curriculum overrides, `parentLinks` management) and `teacher`
  (scoped to their own class only, same as CellConnect's `leader`).
- **Entity renames**: `church → school`, `cell → class`, `member → parent`,
  `leader → teacher`, `secretary/pastor → admin`.
- **All backend routes, middleware, scripts, and frontend pages** renamed and
  verified: every file passes `node --check`, every `getElementById` call in
  `admin.js` matches an `id` in `admin.html` exactly, and a full sweep confirms
  no leftover CellConnect terminology outside of filenames and one intentional
  historical note in `middleware/auth.js`.
- **One real logic bug found and fixed during the rename**: the original
  three-role UI logic (`secretary` full access / `pastor` view-only / `leader`
  own-class) collapsed `secretary` and `pastor` into the same `admin` string,
  which briefly made admin *view-only* for attendance recording. Fixed —
  admin now has full access everywhere, matching the two-role design.
- **`firestore.rules`** ported and extended with the `lessonPlans`, `homework`,
  `curriculumOverrides`, `globalCurriculum`, and `parentLinks` rules designed
  for this project (see below) — documentation/defense-in-depth only, since
  the backend's Admin SDK bypasses these rules today, same as CellConnect.

## What's NOT yet built (scoped in planning, not yet coded)

- `lessonPlans` CRUD (routes + Firestore reads/writes) — schema and rules are
  designed, routes not yet written.
- `homework` CRUD + the AI/OCR flow (Claude for OCR, Gemini 2.0 Flash for
  structuring) — not yet coded.
- `globalCurriculum` / `curriculumOverrides` — hybrid model designed (global
  Softica-maintained defaults, schools can override), content not yet sourced
  or seeded (plan: existing school schemes of work + KICD, Primary + JSS
  first, Senior Secondary added as cohorts progress).
- Analytics module (per sub-strand, rolling up to per-subject).
- Print/export options.
- Bottom-nav UI for the four new modules above.

## Setup

Same as CellConnect's `docs/INSTALL.md` (not yet rewritten for Elimu Smart):
copy `backend/.env.example` to `backend/.env` and fill in your Firebase
service account + WhatsApp Cloud API credentials, then
`node scripts/create-first-admin.js` to create your first school + admin
account.

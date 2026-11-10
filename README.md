# Teamloom

Multi-tenant AI work operating system for teams: projects, tasks & dependencies, meetings & documents, real-time collaboration, and an approval-gated AI layer backed by PostgreSQL 16 Row-Level Security (RLS) and `pgvector`.

## Architecture & Stack
- **Monorepo:** pnpm workspaces + Turborepo
- **Backend:** NestJS (Fastify adapter), Drizzle ORM (hand-written SQL migrations), BullMQ, Socket.IO (Redis adapter)
- **Frontend:** Next.js (App Router), React 19, Tailwind CSS, shadcn/ui, TanStack Query
- **Database & Infra:** PostgreSQL 16 (`pgvector` + strict Row-Level Security), Redis 7, Mailpit
- **AI Layer:** Provider-agnostic LLM Gateway with Zod schema validation, token/cost accounting, per-org budgets, and human-in-the-loop approval inbox
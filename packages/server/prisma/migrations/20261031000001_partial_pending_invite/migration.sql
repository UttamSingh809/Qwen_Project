-- Partial unique index: at most one PENDING invitation per (project, email).
-- Prisma cannot express partial indexes in schema.prisma, so this is added via SQL.
CREATE UNIQUE INDEX "invitation_one_pending_per_project_email"
  ON "Invitation" ("projectId", "email")
  WHERE "status" = 'PENDING';

-- Apply the same invariant to the test database template used by integration tests.

// Business rules: role hierarchy, task status transitions, date validation,
// pagination and sorting whitelists. Pure functions — unit tested in isolation.

import { ProjectRole, TaskPriority, TaskStatus } from '@prisma/client';
import { badRequest } from './errors';

// ---------------------------------------------------------------------------
// Roles / permissions
// ---------------------------------------------------------------------------

export const ROLE_RANK: Record<ProjectRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  MEMBER: 2,
  VIEWER: 1,
};

export function roleAtLeast(role: ProjectRole | null | undefined, min: ProjectRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Roles an admin may grant (never OWNER; ownership transfers via dedicated action only). */
export const ASSIGNABLE_ROLES: ProjectRole[] = ['ADMIN', 'MEMBER', 'VIEWER'];

// ---------------------------------------------------------------------------
// Task status transitions
// ---------------------------------------------------------------------------

/**
 * Documented business rule: tasks flow forward TODO -> IN_PROGRESS -> IN_REVIEW -> DONE,
 * may move back at most one step for corrections (e.g. after review feedback),
 * but a DONE task is final and cannot be reopened through the status API.
 */
export const STATUS_ORDER: TaskStatus[] = [TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW, TaskStatus.DONE];

export function isValidStatusTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true; // idempotent no-op allowed
  if (from === TaskStatus.DONE) return false; // done is final
  const fi = STATUS_ORDER.indexOf(from);
  const ti = STATUS_ORDER.indexOf(to);
  return ti - fi <= 1 && ti - fi >= -1; // forward one step or back one step
}

export function assertStatusTransition(from: TaskStatus, to: TaskStatus): void {
  if (!isValidStatusTransition(from, to)) {
    throw badRequest(`Invalid status transition from ${from} to ${to}`);
  }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function assertValidDateRange(startDate?: Date | null, dueDate?: Date | null): void {
  if (startDate && dueDate && startDate.getTime() > dueDate.getTime()) {
    throw badRequest('Start date must not be after due date');
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function isOverdue(dueDate: Date | null | undefined, now: Date): boolean {
  return !!dueDate && dueDate.getTime() < now.getTime();
}

export function isDueSoon(dueDate: Date | null | undefined, now: Date, withinDays = 7): boolean {
  if (!dueDate) return false;
  const t = dueDate.getTime();
  return t >= now.getTime() && t <= now.getTime() + withinDays * DAY_MS;
}

// ---------------------------------------------------------------------------
// Priority ordering (for sorting & dashboard grouping)
// ---------------------------------------------------------------------------

export const PRIORITY_RANK: Record<TaskPriority, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  URGENT: 4,
};

// ---------------------------------------------------------------------------
// Pagination / sorting whitelist
// ---------------------------------------------------------------------------

export const TASK_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'title',
  'priority',
  'status',
  'dueDate',
  'startDate',
] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

export const PROJECT_SORT_FIELDS = ['createdAt', 'updatedAt', 'name'] as const;

export interface PageParams {
  page: number;
  pageSize: number;
}

export function parsePagination(raw: unknown, rawSize: unknown, maxPageSize = 100): PageParams {
  let page = Number(raw ?? 1);
  let pageSize = Number(rawSize ?? 20);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 20;
  if (pageSize > maxPageSize) pageSize = maxPageSize;
  return { page: Math.floor(page), pageSize: Math.floor(pageSize) };
}

export function paginationMeta(total: number, page: number, pageSize: number) {
  return {
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// Zod schemas for all API inputs. All untrusted input passes through here.

import { z } from 'zod';
import { TaskPriority, TaskStatus, ProjectRole } from '@prisma/client';

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('Invalid email address')
  .transform((s) => s.toLowerCase());

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((s) => /[a-zA-Z]/.test(s), 'Password must contain a letter')
  .refine((s) => /[0-9]/.test(s), 'Password must contain a digit');

const nameSchema = z.string().trim().min(1, 'Name is required').max(100);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(200),
});

export const updateProfileSchema = z.object({
  name: nameSchema,
  email: emailSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required').max(120),
  description: z.string().trim().max(2000).default(''),
});

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    archived: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });

export const inviteSchema = z.object({
  email: emailSchema,
  role: z.nativeEnum(ProjectRole).refine((r) => r !== ProjectRole.OWNER, 'Cannot invite as OWNER'),
});

export const memberRoleSchema = z.object({
  role: z.enum([ProjectRole.ADMIN, ProjectRole.MEMBER, ProjectRole.VIEWER]),
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const optionalDate = z
  .string()
  .datetime({ offset: true, message: 'Must be an ISO-8601 date-time' })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'))
  .optional()
  .nullable();

export const taskBaseSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(200),
    description: z.string().trim().max(5000).default(''),
    priority: z.nativeEnum(TaskPriority).default(TaskPriority.MEDIUM),
    status: z.nativeEnum(TaskStatus).default(TaskStatus.TODO),
    startDate: optionalDate,
    dueDate: optionalDate,
    assigneeId: z.string().uuid().optional().nullable(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  })
  .refine(
    (o) => {
      if (!o.startDate || !o.dueDate) return true;
      return new Date(o.startDate).getTime() <= new Date(o.dueDate).getTime();
    },
    { message: 'Start date must not be after due date', path: ['startDate'] },
  );

export const createTaskSchema = taskBaseSchema;

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).optional(),
    priority: z.nativeEnum(TaskPriority).optional(),
    status: z.nativeEnum(TaskStatus).optional(),
    startDate: optionalDate,
    dueDate: optionalDate,
    assigneeId: z.string().uuid().optional().nullable(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' })
  .refine(
    (o) => {
      if (!o.startDate || !o.dueDate) return true;
      return new Date(o.startDate).getTime() <= new Date(o.dueDate).getTime();
    },
    { message: 'Start date must not be after due date', path: ['startDate'] },
  );

export const taskQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.nativeEnum(TaskStatus).optional(),
  priority: z.nativeEnum(TaskPriority).optional(),
  assigneeId: z.string().uuid().optional(),
  tag: z.string().trim().max(50).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  dueSoon: z.enum(['true', 'false']).optional(),
  sort: z.string().max(50).optional(), // validated against whitelist in the route
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const changeStatusSchema = z.object({
  status: z.nativeEnum(TaskStatus),
});

export const assignSchema = z.object({
  assigneeId: z.string().uuid().nullable(),
});

// ---------------------------------------------------------------------------
// Comments / tags
// ---------------------------------------------------------------------------

export const commentSchema = z.object({
  body: z.string().trim().min(1, 'Comment cannot be empty').max(5000),
});

export const tagSchema = z.object({
  name: z.string().trim().min(1, 'Tag name is required').max(50),
});

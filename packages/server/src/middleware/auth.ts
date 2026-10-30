// Auth & authorization middleware. All permission checks happen server-side.

import { NextFunction, Request, Response } from 'express';
import { ProjectRole } from '@prisma/client';
import { prisma } from '../db';
import { forbidden, notFound, unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../lib/auth';
import { roleAtLeast } from '../lib/businessRules';

export interface AuthUser {
  id: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      projectAccess?: { projectId: string; role: ProjectRole | null };
    }
  }
}

/** Extracts Bearer access token and attaches req.user. Rejects if missing/invalid. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) throw unauthorized();
    const payload = verifyAccessToken(match[1]);
    // Confirm the user still exists (prevents use-after-delete tokens).
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true },
    });
    if (!user) throw unauthorized('User no longer exists');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Resolves the :projectId route parameter against the authenticated user's
 * membership. Sets req.projectAccess. Throws 403 when the user is not a member
 * (or 404 for non-view endpoints when the project does not exist at all —
 * we return 404 only when the project id is invalid to avoid leaking existence
 * of private projects to non-members: non-members always get 403).
 */
export async function loadProjectAccess(req: Request, _res: Response, next: NextFunction) {
  try {
    const projectId = req.params.projectId ?? req.body.projectId;
    if (!req.user) throw unauthorized();
    if (!projectId) throw forbidden('Project context required');
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw notFound('Project not found');
    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: req.user.id } },
    });
    const role: ProjectRole | null = project.ownerId === req.user.id ? ProjectRole.OWNER : membership?.role ?? null;
    req.projectAccess = { projectId, role };
    next();
  } catch (err) {
    next(err);
  }
}

/** Requires at least `min` role in the resolved project access context. */
export function requireRole(min: ProjectRole) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const access = req.projectAccess;
    if (!access || !roleAtLeast(access.role, min)) {
      return next(forbidden(`Requires ${min} role or higher`));
    }
    next();
  };
}

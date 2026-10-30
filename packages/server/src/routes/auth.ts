// Authentication routes: register, login, refresh (rotation), logout, me.
// Refresh token is delivered as an httpOnly cookie AND returned in the JSON body
// (body support keeps API clients like Playwright/tests simple; the cookie backs
// the browser SPA).

import { Router } from 'express';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { asyncHandler, conflict, unauthorized } from '../lib/errors';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from '../lib/validation';
import {
  hashPassword,
  issueRefreshToken,
  revokeAllUserTokens,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  verifyPassword,
} from '../lib/auth';
import { requireAuth } from '../middleware/auth';
import { logger } from '../lib/logger';

export const REFRESH_COOKIE = 'taskflow_refresh';

function setRefreshCookie(res: any, secret: string) {
  res.cookie(REFRESH_COOKIE, secret, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/api/v1/auth',
    maxAge: config.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  });
}

function readRefreshToken(req: any): string | null {
  const fromBody = req.body?.refreshToken;
  if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody;
  const fromCookie = req.cookies?.[REFRESH_COOKIE];
  if (typeof fromCookie === 'string' && fromCookie.length > 0) return fromCookie;
  return null;
}

const publicUser = (u: { id: string; email: string; name: string; createdAt: Date }) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  createdAt: u.createdAt,
});

export function createAuthRouter(rateLimiterFactory: (windowMs: number, max: number) => any): Router {
  const router = Router();

  // Stricter limiter for credential endpoints (per-IP).
  const authLimiter = rateLimiterFactory(15 * 60 * 1000, 20);

  // ------------------------------------------------------------------ register
  router.post(
    '/register',
    authLimiter,
    asyncHandler(async (req, res) => {
      const data = registerSchema.parse(req.body);
      try {
        const passwordHash = await hashPassword(data.password);
        const result = await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: { email: data.email, passwordHash, name: data.name },
          });
          const familyId = crypto.randomUUID();
          const rt = await issueRefreshToken(user.id, familyId, req.ip);
          return { user, rt };
        });
        // NOTE: issuing inside the transaction above uses the global client for
        // simplicity of helper reuse; uniqueness on email is enforced by DB even
        // under concurrent requests (P2002 below).
        const accessToken = signAccessToken(result.user.id, result.user.email);
        setRefreshCookie(res, result.rt.secret);
        logger.info('user-registered', { userId: result.user.id });
        res.status(201).json({
          user: publicUser(result.user),
          accessToken,
          refreshToken: result.rt.secret,
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw conflict('An account with this email already exists');
        }
        throw err;
      }
    }),
  );

  // ---------------------------------------------------------------------- login
  router.post(
    '/login',
    authLimiter,
    asyncHandler(async (req, res) => {
      const data = loginSchema.parse(req.body);
      const user = await prisma.user.findUnique({ where: { email: data.email } });
      // Constant-ish behaviour: verify against a dummy hash when user missing to
      // reduce timing-based user enumeration.
      const valid = user
        ? await verifyPassword(user.passwordHash, data.password)
        : await verifyPassword(
            '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$k3xq8dJnQeGzY4rPvV7QxKZ3F0Yx8cF2W0sV1nBqk7E',
            data.password,
          );
      if (!user || !valid) {
        logger.warn('login-failed', { email: data.email });
        throw unauthorized('Invalid email or password');
      }
      const rt = await issueRefreshToken(user.id, null, req.ip);
      const accessToken = signAccessToken(user.id, user.email);
      setRefreshCookie(res, rt.secret);
      logger.info('user-login', { userId: user.id });
      res.json({ user: publicUser(user), accessToken, refreshToken: rt.secret });
    }),
  );

  // --------------------------------------------------------- refresh (rotation)
  router.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      const secret = readRefreshToken(req);
      if (!secret) throw unauthorized('Missing refresh token');
      const { userId, newSecret } = await rotateRefreshToken(secret, req.ip);
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw unauthorized('User no longer exists');
      const accessToken = signAccessToken(user.id, user.email);
      setRefreshCookie(res, newSecret);
      res.json({ accessToken, refreshToken: newSecret, user: publicUser(user) });
    }),
  );

  // --------------------------------------------------------------------- logout
  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const secret = readRefreshToken(req);
      if (secret) await revokeRefreshToken(secret);
      res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
      res.status(204).send();
    }),
  );

  // -------------------------------------------------------- logout all sessions
  router.post('/logout-all', requireAuth, asyncHandler(async (req, res) => {
    await revokeAllUserTokens(req.user!.id);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    res.status(204).send();
  }));

  // ------------------------------------------------------------------------- me
  router.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw unauthorized();
    res.json({ user: publicUser(user) });
  }));

  // ------------------------------------------------------------------- profile
  router.patch('/me', requireAuth, asyncHandler(async (req, res) => {
    const data = updateProfileSchema.parse(req.body);
    try {
      const user = await prisma.user.update({
        where: { id: req.user!.id },
        data: { name: data.name, email: data.email },
      });
      res.json({ user: publicUser(user) });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict('An account with this email already exists');
      }
      throw err;
    }
  }));

  // ------------------------------------------------------------ change password
  router.post(
    '/change-password',
    requireAuth,
    authLimiter,
    asyncHandler(async (req, res) => {
      const data = changePasswordSchema.parse(req.body);
      const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
      if (!user) throw unauthorized();
      const ok = await verifyPassword(user.passwordHash, data.currentPassword);
      if (!ok) throw unauthorized('Current password is incorrect');
      const passwordHash = await hashPassword(data.newPassword);
      await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
        // Security: change of password invalidates every existing session.
        prisma.refreshToken.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
      logger.info('password-changed', { userId: user.id });
      res.status(204).send();
    }),
  );

  return router;
}

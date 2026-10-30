// Authentication helpers: argon2id password hashing, JWT access tokens and
// rotating refresh tokens (opaque random secrets stored only as SHA-256 hashes).

import crypto from 'crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../db';
import { unauthorized } from '../lib/errors';

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  type: 'access';
}

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB — OWASP recommendation
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function signAccessToken(userId: string, email: string): string {
  const payload: AccessTokenPayload = { sub: userId, email, type: 'access' };
  return jwt.sign(payload, config.jwtAccessSecret, {
    expiresIn: `${config.accessTokenTtlMinutes}m`,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, config.jwtAccessSecret, { algorithms: ['HS256'] });
    if (typeof decoded === 'object' && decoded.type === 'access' && typeof decoded.sub === 'string') {
      return decoded as unknown as AccessTokenPayload;
    }
    throw unauthorized('Invalid token');
  } catch (err) {
    if (err instanceof Error && err.name === 'AppError') throw err;
    throw unauthorized('Invalid or expired token');
  }
}

export function generateRefreshTokenSecret(): string {
  return crypto.randomBytes(48).toString('base64url');
}

export function hashRefreshToken(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/** Issues a new refresh token in a rotation family. */
export async function issueRefreshToken(
  userId: string,
  familyId: string | null,
  ip?: string,
): Promise<{ secret: string; tokenHash: string; familyId: string }> {
  const secret = generateRefreshTokenSecret();
  const tokenHash = hashRefreshToken(secret);
  const family = familyId ?? crypto.randomUUID();
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: { tokenHash, familyId: family, userId, expiresAt, createdByIp: ip ?? null },
  });
  return { secret, tokenHash, familyId: family };
}

/**
 * Rotates a refresh token: marks the presented token revoked and issues a new one
 * in the same family. If a already-revoked token is reused (possible theft),
 * the entire family is revoked (defense against refresh-token replay).
 */
export async function rotateRefreshToken(
  secret: string,
  ip?: string,
): Promise<{ userId: string; newSecret: string }> {
  const tokenHash = hashRefreshToken(secret);
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!record) throw unauthorized('Invalid refresh token');

  if (record.revokedAt) {
    // Reuse detected -> revoke whole family.
    await prisma.refreshToken.updateMany({
      where: { familyId: record.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw unauthorized('Refresh token reuse detected; session revoked');
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    throw unauthorized('Refresh token expired');
  }

  const rotated = await prisma.$transaction(async (tx) => {
    await tx.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    const secret2 = generateRefreshTokenSecret();
    await tx.refreshToken.create({
      data: {
        tokenHash: hashRefreshToken(secret2),
        familyId: record.familyId,
        userId: record.userId,
        expiresAt: new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000),
        createdByIp: ip ?? null,
      },
    });
    return secret2;
  });

  return { userId: record.userId, newSecret: rotated };
}

/** Revokes a single refresh token (logout). */
export async function revokeRefreshToken(secret: string): Promise<void> {
  const tokenHash = hashRefreshToken(secret);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revokes ALL refresh tokens of a user (password change / security events). */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// Application error type + centralized error handler.
// Internal errors are never leaked to clients; only safe, coded messages.

import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { logger } from './logger';

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg = 'Bad request', details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Resource not found') =>
  new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg = 'Conflict', details?: unknown) =>
  new AppError(409, 'CONFLICT', msg, details);

/** Maps unexpected Prisma errors to safe client responses. */
function mapPrismaError(err: Prisma.PrismaClientKnownRequestError): AppError {
  switch (err.code) {
    case 'P2002':
      return conflict('A record with these unique values already exists');
    case 'P2003':
      return badRequest('Related record constraint violated');
    case 'P2025':
      return notFound();
    default:
      return new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  let appErr: AppError;

  if (err instanceof AppError) {
    appErr = err;
  } else if (err instanceof ZodError) {
    appErr = badRequest(
      'Validation failed',
      err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    );
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    appErr = mapPrismaError(err);
  } else {
    appErr = new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
    logger.error('unhandled-error', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      path: req.path,
    });
  }

  if (appErr.status >= 500) {
    logger.error('request-failed', { path: req.path, code: appErr.code });
  }

  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: appErr.message,
      ...(appErr.details !== undefined ? { details: appErr.details } : {}),
    },
  });
}

/** Wraps async route handlers so rejections reach the error handler. */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(
  fn: T,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

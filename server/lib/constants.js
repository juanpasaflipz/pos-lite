/**
 * Shared constants used across multiple route files.
 */

export const BCRYPT_ROUNDS = 12;

export const JWT_SECRET = process.env.JWT_SECRET || (
  process.env.NODE_ENV === 'production'
    ? (() => { console.error('FATAL: JWT_SECRET is required in production.'); process.exit(1); })()
    : 'dev-jwt-secret-change-me'
);

export const JWT_EMPLOYEE_EXPIRY = '24h';

export const JWT_OWNER_EXPIRY = '7d';

export const MAX_PAGE_LIMIT = 200;


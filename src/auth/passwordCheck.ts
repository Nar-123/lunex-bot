import bcrypt from 'bcrypt';

/** Timing-safe (bcrypt's own comparison) password check against a stored hash. */
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

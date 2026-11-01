import { z } from 'zod';

/** Matches Better Auth's default `minPasswordLength`; createUser itself does not enforce it. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

export const nameSchema = z.string().trim().min(1).max(100);
export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);

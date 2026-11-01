import { integrationEnvShape, parseEnv, refineIntegrationEnv } from '@arfolio/core';
import { z } from 'zod';
import { parseExtraRedirectUris } from './mcp-redirect';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb colour');

export const envSchema = z
  .object({
    /** Connection string for the unprivileged `pfm_app` role. */
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    /** Public origin; trailing slashes are dropped so `${APP_URL}/path` is always well formed. */
    APP_URL: z.url().transform((url) => url.replace(/\/+$/, '')),
    SETUP_TOKEN: z.string().min(24),
    /**
     * Header carrying the real client address, set by the trusted reverse proxy (Traefik sets
     * X-Real-Ip). Used for rate limiting; client-supplied X-Forwarded-For is deliberately ignored.
     */
    CLIENT_IP_HEADER: z.string().min(1).default('x-real-ip'),
    BRAND_NAME: z.string().min(1).default('Arfolio'),
    // Default Folio Cobalt, oklch(0.501 0.169 263.9); globals.css carries the same values as a fallback.
    BRAND_PRIMARY_COLOR: hexColor.default('#2F5BC2'),
    BRAND_LOGO_URL: z.url().optional(),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().optional(),
    DEFAULT_LOCALE: z.string().min(2).default('en'),
    /**
     * Extra exact OAuth redirect URIs MCP clients may register, comma separated (optional; the
     * Claude connector and loopback callbacks are always allowed). An empty value counts as unset.
     */
    MCP_ALLOWED_REDIRECT_URIS: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .transform(parseExtraRedirectUris)
        .refine(
          (uris) =>
            uris.every((uri) => {
              try {
                return new URL(uri).hash === '';
              } catch {
                return false;
              }
            }),
          'expected comma separated absolute URIs without a fragment',
        )
        .optional(),
    ),
    ...integrationEnvShape,
  })
  .superRefine(refineIntegrationEnv);

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Parses process.env on first use, not at import time, so `next build` works without runtime
 * configuration. Throws an EnvError (keys only, never values) when the environment is invalid.
 */
export function getEnv(): Env {
  cached ??= parseEnv(envSchema, process.env);
  return cached;
}

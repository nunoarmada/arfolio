import type { AnthropicCreateLike, AnthropicLike, IntegrationConfig } from '@arfolio/services';
import { log } from './log.js';

export type AnthropicClient = AnthropicLike & AnthropicCreateLike;
/** Builds (or reuses) the Anthropic client for a config; `null` when AI is not available. */
export type AnthropicProvider<C = AnthropicClient> = (cfg: IntegrationConfig) => C | null;
export type GetConfig = () => Promise<IntegrationConfig>;

/** Why there is no client: nothing configured, or a stored key that cannot be decrypted. */
export function aiOffReason(cfg: IntegrationConfig): string {
  return cfg.anthropicApiKey.unreadable
    ? 'the stored Anthropic API key cannot be decrypted with the current ENCRYPTION_KEY'
    : 'ANTHROPIC_API_KEY is not set';
}

/** A model setting always has a default; an undefined one means the config is broken. */
export function modelOf(
  model: IntegrationConfig['models'][keyof IntegrationConfig['models']],
): string {
  if (model.value === undefined) throw new Error('AI model is not configured');
  return model.value;
}

/**
 * Reads the integration config at the start of each run. Returns the config and client, or
 * `null` when AI is off, logging that once per stretch of being off (jobs run every minute).
 */
export function createAiGate<C>(
  label: string,
  getConfig: GetConfig,
  getAnthropic: AnthropicProvider<C>,
) {
  let offLogged = false;
  return async (): Promise<{ cfg: IntegrationConfig; anthropic: C } | null> => {
    const cfg = await getConfig();
    const anthropic = getAnthropic(cfg);
    if (!anthropic) {
      if (!offLogged) log.info(`${label} is off: ${aiOffReason(cfg)}`);
      offLogged = true;
      return null;
    }
    offLogged = false;
    return { cfg, anthropic };
  };
}

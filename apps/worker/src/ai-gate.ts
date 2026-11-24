import {
  AiKeyChangedError,
  type AnthropicCreateLike,
  type AnthropicLike,
  type IntegrationConfig,
} from '@arfolio/services';
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

/** The SDK namespaces whose methods send requests; their methods are guarded. */
const GUARDED = new Set<PropertyKey>(['messages', 'models']);

/**
 * Wraps `client` so that every method of `messages` and `models` first reads the config (cached,
 * dropped by the settings listener) and throws {@link AiKeyChangedError}, before anything is sent,
 * when the key is no longer `apiKey`. A run can last up to `AI_MAX_RUN_MS`: a key removed or
 * replaced meanwhile is not used for one more request.
 */
export function guardClient<C>(client: C, apiKey: string | undefined, getConfig: GetConfig): C {
  const check = async (): Promise<void> => {
    if ((await getConfig()).anthropicApiKey.value !== apiKey) throw new AiKeyChangedError();
  };
  const guardNamespace = (ns: object): object =>
    new Proxy(ns, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          await check();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  return new Proxy(client as object, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      return GUARDED.has(prop) && typeof value === 'object' && value !== null
        ? guardNamespace(value)
        : value;
    },
  }) as C;
}

/**
 * Reads the integration config at the start of each run. Returns the config and a client guarded
 * by {@link guardClient}, or `null` when AI is off, logging that once per stretch of being off
 * (jobs run every minute).
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
    return { cfg, anthropic: guardClient(anthropic, cfg.anthropicApiKey.value, getConfig) };
  };
}

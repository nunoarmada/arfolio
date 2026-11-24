import { createAdvisorClient, type AdvisorModelClient } from '@arfolio/mcp';

/**
 * The one place the web app builds the advisor's model client. A module of its own so tests
 * replace it with a fake: nothing in a test run may reach a real Anthropic endpoint. The SDK
 * default base URL honours `ANTHROPIC_BASE_URL` already.
 */
export const createClient = (apiKey: string): AdvisorModelClient => createAdvisorClient(apiKey);

import { type RailConfig, railConfigSchema } from '@agent-rail/config';

export type AgentRuntimeConfig = Pick<RailConfig, 'agents' | 'observability' | 'security'>;

export function defaultAgentRuntimeConfig(): AgentRuntimeConfig {
  return {
    agents: railConfigSchema.shape.agents.parse(undefined),
    observability: railConfigSchema.shape.observability.parse(undefined),
    security: railConfigSchema.shape.security.parse(undefined),
  };
}

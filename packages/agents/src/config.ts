import { type CrewConfig, crewConfigSchema } from '@crewyard/config';

export type AgentRuntimeConfig = Pick<CrewConfig, 'agents' | 'observability' | 'security'>;

export function defaultAgentRuntimeConfig(): AgentRuntimeConfig {
  return {
    agents: crewConfigSchema.shape.agents.parse(undefined),
    observability: crewConfigSchema.shape.observability.parse(undefined),
    security: crewConfigSchema.shape.security.parse(undefined),
  };
}

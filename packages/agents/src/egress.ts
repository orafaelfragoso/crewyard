import type { CrewConfig } from '@crewyard/config';
import type { AccountProfile, ProviderId } from '@crewyard/core';
import { type DataDestination, providerManifest } from './registry.ts';

export interface DataRoutingDecision {
  providerId: ProviderId;
  decision: 'allow' | 'deny';
  reason: string;
  destination: DataDestination;
  disclosure: string;
}

const PLACEHOLDER_PROFILE: Omit<AccountProfile, 'providerId'> = {
  id: '',
  name: 'default',
  displayName: 'default',
  authMechanism: 'none',
  authRef: null,
  configRoot: null,
  permittedModels: [],
  maxConcurrency: 1,
  settings: {},
};

export function dataRoutingDecision(
  config: Pick<CrewConfig, 'security'>,
  providerId: ProviderId,
  profile?: AccountProfile,
): DataRoutingDecision {
  const manifest = providerManifest(providerId);
  const subject = profile ?? { ...PLACEHOLDER_PROFILE, providerId };
  const destination = manifest.destination(subject);
  const disclosure = manifest.disclosure(subject);
  const routing = config.security.data_routing;
  const keys = [...(profile ? [`${providerId}/${profile.name}`] : []), providerId, '*'];
  for (const key of keys) {
    const rule = routing[key];
    if (rule) {
      return { providerId, decision: rule, reason: `security.data_routing.${key} = ${rule}`, destination, disclosure };
    }
  }
  if (config.security.network === 'offline' && destination !== 'local') {
    return {
      providerId,
      decision: 'deny',
      reason: 'security.network is offline and this provider is not local',
      destination,
      disclosure,
    };
  }
  return {
    providerId,
    decision: 'allow',
    reason: 'no data routing rule denies this provider',
    destination,
    disclosure,
  };
}

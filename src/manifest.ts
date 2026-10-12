import type { AppDescriptor, AppPermissionDescriptor } from '@privos_ai/app-server';

import publisherManifest from '../privos-app.json';
import { getAppIconDataUri } from './app-icon';

export const MARKETPLACE_MANIFEST_FIELDS = [
  'schemaVersion', 'kind', 'name', 'version', 'title', 'description', 'icon',
  'author', 'homepage', 'repository', 'permissions', 'dataPolicy', 'availabilityTier',
  'capabilities', 'agentBot', 'tools', 'port', 'resources', 'volumes', 'stateless', 'license', 'env',
  'resourceManifestTemplate', 'ui',
] as const;

export const HUB_MANIFEST_FIELDS = MARKETPLACE_MANIFEST_FIELDS;

export type AppManifest = Pick<typeof publisherManifest, (typeof MARKETPLACE_MANIFEST_FIELDS)[number]>;

export function createManifest(): AppManifest {
  return Object.fromEntries(
    MARKETPLACE_MANIFEST_FIELDS.map((field) => [field, publisherManifest[field]]),
  ) as AppManifest;
}

/**
 * The `AppDescriptor` the SDK's Relay transport (`connectRelay`, `pairOverWebSocket`)
 * needs — built straight from the reviewed manifest so a relay-paired install (development
 * pairing or a standalone-production install) advertises exactly what the Marketplace listing
 * declares. Never hand-build a second descriptor: this is the one source of truth.
 */
export function buildRelayAppDescriptor(): AppDescriptor {
  return {
    id: publisherManifest.name,
    name: publisherManifest.name,
    version: publisherManifest.version,
    title: publisherManifest.title,
    description: publisherManifest.description,
    homepage: publisherManifest.homepage,
    author: publisherManifest.author,
    // `privos-app.json` is the reviewed manifest (npm run manifest:lint enforces its shape);
    // the JSON import widens string literal fields (e.g. requirement) to `string`, so a
    // structural cast is safe here rather than duplicating the schema in TypeScript.
    permissions: publisherManifest.permissions as readonly AppPermissionDescriptor[],
    manifestIcon: publisherManifest.icon,
    relayIcon: getAppIconDataUri(),
  };
}

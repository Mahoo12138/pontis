import { client } from '../client';
import { checkDistributionExtensions } from '../contract';
import type { DistributionResponse } from '../types';

/**
 * The extension packages this server carries. Read by the install page to list
 * what to download, and by the extension to answer "is there a newer package
 * here" — a question it is allowed to ask of any instance it is paired with,
 * which is why the answer declares the server's own version next to its own.
 */
export function getExtensionDistribution() {
  return client.get<DistributionResponse>(
    '/distribution/extensions',
    checkDistributionExtensions,
  );
}

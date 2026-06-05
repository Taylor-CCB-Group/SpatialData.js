import { DEFAULT_FIXTURE_SERVER_PORT } from './fixture-server-defaults.mjs';

/**
 * Fixture server port for Node tooling (test server, Vite proxy, integration tests).
 *
 * Override with SPATIALDATA_FIXTURE_PORT (or PORT for compatibility).
 */
export const FIXTURE_SERVER_PORT = Number(
  process.env.SPATIALDATA_FIXTURE_PORT ?? process.env.PORT ?? DEFAULT_FIXTURE_SERVER_PORT
);

export function fixtureServerOrigin(host = '127.0.0.1') {
  return `http://${host}:${FIXTURE_SERVER_PORT}`;
}

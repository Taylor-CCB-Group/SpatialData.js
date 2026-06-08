import { DEFAULT_FIXTURE_SERVER_PORT } from './fixture-server-defaults.mjs';

/**
 * Fixture server port for Node tooling (test server, Vite proxy, integration tests).
 *
 * Override with SPATIALDATA_FIXTURE_PORT (or PORT for compatibility).
 */
export const FIXTURE_SERVER_PORT = Number(
  process.env.SPATIALDATA_FIXTURE_PORT ?? process.env.PORT ?? DEFAULT_FIXTURE_SERVER_PORT
);

if (!Number.isInteger(FIXTURE_SERVER_PORT) || FIXTURE_SERVER_PORT < 1 || FIXTURE_SERVER_PORT > 65535) {
  throw new Error(
    `Invalid fixture server port: ${FIXTURE_SERVER_PORT}. ` +
      'Set SPATIALDATA_FIXTURE_PORT (or PORT) to an integer between 1 and 65535.'
  );
}

export function fixtureServerOrigin(host = '127.0.0.1') {
  return `http://${host}:${FIXTURE_SERVER_PORT}`;
}

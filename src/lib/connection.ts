import { QUICKBOOKS_MODULE } from "../modules/quickbooks";
import type QuickbooksModuleService from "../modules/quickbooks/service";
import {
  getQuickbooksConfig,
  isConnectionExpired,
  refreshOauthToken,
  toStoredConnection,
} from "./quickbooks";

type ScopeLike = {
  resolve: (name: string) => any;
};

// QuickBooks rotates refresh tokens: two concurrent refreshes with the same
// token can invalidate the stored session and make pages report
// "disconnected" until a lone request refreshes cleanly. Serialize refreshes
// so concurrent requests share one refresh and re-read the stored result.
let refreshInFlight: Promise<unknown> | null = null;

export async function getReadyQuickbooksConnection(
  scope: ScopeLike,
  actorId?: string | null,
  config: ReturnType<typeof getQuickbooksConfig> = getQuickbooksConfig(),
) {
  const quickbooksService: QuickbooksModuleService =
    scope.resolve(QUICKBOOKS_MODULE);

  if (!config.configured) {
    return { quickbooksService, config, connection: null };
  }

  let connection = await quickbooksService.getConnection();

  if (
    connection &&
    connection.refresh_token &&
    isConnectionExpired(connection)
  ) {
    if (!refreshInFlight) {
      const staleConnection = connection;

      refreshInFlight = (async () => {
        const refreshedToken = await refreshOauthToken(staleConnection, config);

        return await quickbooksService.upsertConnection(
          toStoredConnection(refreshedToken, actorId),
        );
      })().finally(() => {
        refreshInFlight = null;
      });

      connection = (await refreshInFlight) as typeof connection;
    } else {
      // Another request is already refreshing — wait for it, then read the
      // stored connection it produced.
      await refreshInFlight.catch(() => {});
      connection = await quickbooksService.getConnection();
    }
  }

  if (!connection?.access_token || !connection?.realm_id) {
    return { quickbooksService, config, connection: null };
  }

  return { quickbooksService, config, connection };
}

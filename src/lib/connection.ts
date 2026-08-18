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
// within this process and fail closed when refresh cannot complete.
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

  type QuickbooksConnection = Awaited<
    ReturnType<QuickbooksModuleService["getConnection"]>
  >;
  let connection: QuickbooksConnection | null =
    await quickbooksService.getConnection();

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
    }

    try {
      connection = (await refreshInFlight) as typeof connection;
    } catch (error) {
      // A failed refresh means the stored authorization is not usable. Treat
      // it as disconnected so subscribers and sync routes return a no-op
      // without making any downstream QuickBooks API calls.
      console.warn(
        "[quickbooks-sync] token refresh failed; skipping QuickBooks operation",
        {
          code:
            (error as any)?.response?.data?.Fault?.Error?.[0]?.code ||
            (error as any)?.code ||
            null,
          message: error instanceof Error ? error.message : "Unknown refresh error",
        },
      );
      connection = null;
    }
  }

  if (
    !connection?.access_token ||
    !connection?.refresh_token ||
    !connection?.realm_id
  ) {
    return { quickbooksService, config, connection: null };
  }

  return { quickbooksService, config, connection };
}

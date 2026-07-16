import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";

import type QuickbooksModuleService from "../modules/quickbooks/service";
import { getReadyQuickbooksConnection } from "./connection";
import {
  buildQuickbooksNotes,
  hashCustomerPayload,
  normalizeEmail,
  normalizeMedusaCustomerForSync,
  normalizeQuickbooksCustomerForSync,
  parseQuickbooksNotes,
  toMedusaCustomerInput,
  toQuickbooksCustomerPayload,
} from "./customer-sync";
import {
  createQuickbooksCustomer,
  deactivateQuickbooksCustomer,
  findQuickbooksCustomers,
  getQuickbooksConfig,
  getQuickbooksCustomer,
  updateQuickbooksCustomer,
} from "./quickbooks";

export { getReadyQuickbooksConnection };

type ScopeLike = {
  resolve: (name: string) => any;
};

type QueryGraph = {
  graph: (input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
  }) => Promise<{ data?: Record<string, unknown>[] }>;
};

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
};

export async function getMedusaCustomerById(
  scope: ScopeLike,
  customerId: string,
) {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY) as QueryGraph;
  const response = await query.graph({
    entity: "customer",
    fields: [
      "id",
      "email",
      "first_name",
      "last_name",
      "company_name",
      "phone",
      "has_account",
      "metadata",
      "created_at",
      "updated_at",
    ],
    filters: {
      id: customerId,
    },
  });

  return response.data?.[0] ?? null;
}

export async function listMedusaCustomers(scope: ScopeLike) {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY) as QueryGraph;
  const response = await query.graph({
    entity: "customer",
    fields: [
      "id",
      "email",
      "first_name",
      "last_name",
      "company_name",
      "phone",
      "has_account",
      "metadata",
      "created_at",
      "updated_at",
    ],
  });

  return response.data ?? [];
}

const extractQuickbooksFault = (error: unknown) => {
  const response = (error as { response?: { data?: unknown } } | null)
    ?.response;
  const fault = asRecord(asRecord(response?.data)?.Fault);
  const errors = Array.isArray(fault?.Error) ? fault.Error : [];

  return asRecord(errors[0]);
};

export const extractQuickbooksErrorMessage = (error: unknown) => {
  const faultError = extractQuickbooksFault(error);

  if (faultError) {
    const message =
      typeof faultError.Message === "string"
        ? faultError.Message
        : "QuickBooks request failed";
    const detail =
      typeof faultError.Detail === "string" ? `: ${faultError.Detail}` : "";

    return `${message}${detail}`;
  }

  return error instanceof Error ? error.message : "Unknown QuickBooks error";
};

// QuickBooks error 6240: "Duplicate Name Exists" — DisplayName must be unique
// across all customers, but different Medusa customers can share a name.
const isDuplicateNameError = (error: unknown) => {
  const faultError = extractQuickbooksFault(error);

  if (String(faultError?.code) === "6240") {
    return true;
  }

  return extractQuickbooksErrorMessage(error)
    .toLowerCase()
    .includes("duplicate name");
};

const buildDisplayName = (medusaCustomer: Record<string, unknown>) =>
  String(
    [medusaCustomer.first_name, medusaCustomer.last_name]
      .filter(Boolean)
      .join(" ") ||
      medusaCustomer.email ||
      "",
  ).trim();

type QuickbooksMatchContext = {
  byMedusaId: Map<string, Record<string, unknown>>;
  byEmail: Map<string, Record<string, unknown>>;
  byDisplayName: Map<string, Record<string, unknown>>;
};

const registerInMatchContext = (
  context: QuickbooksMatchContext,
  quickbooksCustomer: Record<string, unknown>,
) => {
  const notes = parseQuickbooksNotes(quickbooksCustomer.Notes);

  if (typeof notes?.medusa_id === "string") {
    context.byMedusaId.set(notes.medusa_id, quickbooksCustomer);
  }

  const email = normalizeEmail(
    asRecord(quickbooksCustomer.PrimaryEmailAddr)?.Address,
  );

  if (email && !context.byEmail.has(email)) {
    context.byEmail.set(email, quickbooksCustomer);
  }

  const displayName =
    typeof quickbooksCustomer.DisplayName === "string"
      ? quickbooksCustomer.DisplayName.trim()
      : "";

  if (displayName && !context.byDisplayName.has(displayName)) {
    context.byDisplayName.set(displayName, quickbooksCustomer);
  }
};

const buildQuickbooksMatchContext = (
  quickbooksCustomers: Record<string, unknown>[],
): QuickbooksMatchContext => {
  const context: QuickbooksMatchContext = {
    byMedusaId: new Map(),
    byEmail: new Map(),
    byDisplayName: new Map(),
  };

  for (const quickbooksCustomer of quickbooksCustomers) {
    registerInMatchContext(context, quickbooksCustomer);
  }

  return context;
};

// A display-name match only counts when the emails agree (or the QuickBooks
// customer has no email) — different people can share a name.
const matchesByName = (
  quickbooksCustomer: Record<string, unknown> | undefined,
  email: string,
) => {
  if (!quickbooksCustomer) {
    return null;
  }

  const quickbooksEmail = normalizeEmail(
    asRecord(quickbooksCustomer.PrimaryEmailAddr)?.Address,
  );

  return !quickbooksEmail || quickbooksEmail === email
    ? quickbooksCustomer
    : null;
};

export async function syncMedusaCustomerToQuickbooks(
  scope: ScopeLike,
  medusaCustomerId: string,
  matchContext?: QuickbooksMatchContext,
) {
  const medusaCustomer = await getMedusaCustomerById(scope, medusaCustomerId);

  if (!medusaCustomer) {
    return { skipped: true, reason: "Customer not found in Medusa." };
  }

  const email = normalizeEmail(medusaCustomer.email);

  if (!email) {
    return {
      skipped: true,
      reason: "Customer email is required for QuickBooks sync.",
    };
  }

  const { quickbooksService, config, connection } =
    await getReadyQuickbooksConnection(scope);

  if (!connection) {
    return { skipped: true, reason: "QuickBooks is not connected." };
  }

  const medusaHash = hashCustomerPayload(
    normalizeMedusaCustomerForSync(medusaCustomer),
  );
  const existingLink =
    await quickbooksService.getCustomerLinkByMedusaCustomerId(
      medusaCustomer.id as string,
    );

  if (
    existingLink?.last_synced_hash === medusaHash &&
    existingLink?.last_direction === "quickbooks_to_medusa"
  ) {
    return {
      skipped: true,
      reason: "Inbound QuickBooks sync already applied.",
    };
  }

  const displayName = buildDisplayName(medusaCustomer);
  let quickbooksCustomer: Record<string, unknown> | null = null;

  if (existingLink?.quickbooks_customer_id) {
    quickbooksCustomer = await getQuickbooksCustomer(
      connection,
      config,
      existingLink.quickbooks_customer_id,
    );
  }

  if (!quickbooksCustomer && matchContext) {
    quickbooksCustomer =
      matchContext.byMedusaId.get(medusaCustomer.id as string) ||
      matchContext.byEmail.get(email) ||
      matchesByName(matchContext.byDisplayName.get(displayName), email) ||
      null;
  } else if (!quickbooksCustomer) {
    // Single-customer sync (subscribers): targeted lookups instead of listing
    // every QuickBooks customer.
    const byEmail = await findQuickbooksCustomers(connection, config, {
      PrimaryEmailAddr: email,
    });

    quickbooksCustomer = byEmail[0] || null;

    if (!quickbooksCustomer && displayName) {
      const byName = await findQuickbooksCustomers(connection, config, {
        DisplayName: displayName,
      });

      quickbooksCustomer = matchesByName(byName[0], email);
    }
  }

  const payload = toQuickbooksCustomerPayload(
    medusaCustomer,
    quickbooksCustomer,
  );
  let syncedCustomer: Record<string, unknown> | null = null;
  let action: "created" | "updated" = quickbooksCustomer
    ? "updated"
    : "created";

  if (quickbooksCustomer) {
    syncedCustomer = await updateQuickbooksCustomer(
      connection,
      config,
      payload,
    );
  } else {
    try {
      syncedCustomer = await createQuickbooksCustomer(
        connection,
        config,
        payload,
      );
    } catch (error) {
      if (!isDuplicateNameError(error)) {
        throw error;
      }

      // Same name, different person: make the QuickBooks display name unique.
      syncedCustomer = await createQuickbooksCustomer(connection, config, {
        ...payload,
        DisplayName: `${displayName} (${email})`,
      });
    }
  }

  if (!syncedCustomer?.Id) {
    return {
      skipped: true,
      reason: "QuickBooks did not return a persisted customer.",
    };
  }

  if (matchContext) {
    registerInMatchContext(matchContext, syncedCustomer);
  }

  await quickbooksService.upsertCustomerLink({
    medusa_customer_id: medusaCustomer.id as string,
    quickbooks_customer_id: String(syncedCustomer.Id),
    quickbooks_sync_token:
      typeof syncedCustomer.SyncToken === "string"
        ? syncedCustomer.SyncToken
        : null,
    realm_id: connection.realm_id || null,
    last_synced_hash: medusaHash,
    last_direction: "medusa_to_quickbooks",
    last_synced_at: new Date(),
    metadata: {
      quickbooks_display_name: syncedCustomer.DisplayName || null,
      notes: buildQuickbooksNotes(medusaCustomer),
    },
  });

  return {
    skipped: false,
    action,
    medusa_customer_id: medusaCustomer.id,
    quickbooks_customer_id: syncedCustomer.Id,
    direction: "medusa_to_quickbooks",
  };
}

export async function syncMedusaCustomersToQuickbooks(scope: ScopeLike) {
  const { config, connection } = await getReadyQuickbooksConnection(scope);

  if (!connection) {
    return {
      connected: false,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      items: [] as Record<string, unknown>[],
    };
  }

  const medusaCustomers = await listMedusaCustomers(scope);

  // Fetch the QuickBooks customer list once and match in memory — fetching it
  // per customer makes bulk syncs O(n²) API calls.
  let quickbooksCustomers: Record<string, unknown>[] = [];
  try {
    quickbooksCustomers = await findQuickbooksCustomers(connection, config);
  } catch (error) {
    console.error(
      "[quickbooks-customer-sync] failed to list QuickBooks customers",
      extractQuickbooksErrorMessage(error),
    );
  }

  const matchContext = buildQuickbooksMatchContext(quickbooksCustomers);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const items: Record<string, unknown>[] = [];

  for (const medusaCustomer of medusaCustomers) {
    const medusaCustomerId = String(medusaCustomer.id);

    try {
      const result = await syncMedusaCustomerToQuickbooks(
        scope,
        medusaCustomerId,
        matchContext,
      );

      if (result.skipped) {
        skipped++;
      } else if (result.action === "created") {
        created++;
      } else {
        updated++;
      }

      items.push(result);
    } catch (error) {
      failed++;
      const reason = extractQuickbooksErrorMessage(error);

      console.error("[quickbooks-customer-sync] failed to sync customer", {
        medusa_customer_id: medusaCustomerId,
        reason,
      });

      items.push({
        medusa_customer_id: medusaCustomerId,
        skipped: true,
        error: true,
        reason,
      });
    }
  }

  return {
    connected: true,
    created,
    updated,
    skipped,
    failed,
    items,
  };
}

export async function deleteMedusaCustomerFromQuickbooks(
  scope: ScopeLike,
  medusaCustomerId: string,
) {
  const { quickbooksService, config, connection } =
    await getReadyQuickbooksConnection(scope);

  if (!connection) {
    return { skipped: true, reason: "QuickBooks is not connected." };
  }

  const existingLink =
    await quickbooksService.getCustomerLinkByMedusaCustomerId(medusaCustomerId);

  if (!existingLink?.quickbooks_customer_id) {
    return { skipped: true, reason: "No QuickBooks customer link found." };
  }

  const quickbooksCustomer = await getQuickbooksCustomer(
    connection,
    config,
    existingLink.quickbooks_customer_id,
  );

  if (!quickbooksCustomer?.Id) {
    return {
      skipped: true,
      reason: "Linked QuickBooks customer was not found.",
      medusa_customer_id: medusaCustomerId,
      quickbooks_customer_id: existingLink.quickbooks_customer_id,
    };
  }

  if (quickbooksCustomer.Active === false) {
    return {
      skipped: true,
      reason: "QuickBooks customer is already inactive.",
      medusa_customer_id: medusaCustomerId,
      quickbooks_customer_id: quickbooksCustomer.Id,
      direction: "medusa_to_quickbooks",
    };
  }

  const deactivatedCustomer = await deactivateQuickbooksCustomer(
    connection,
    config,
    quickbooksCustomer,
  );

  await quickbooksService.upsertCustomerLink({
    medusa_customer_id: medusaCustomerId,
    quickbooks_customer_id: String(existingLink.quickbooks_customer_id),
    quickbooks_sync_token:
      typeof deactivatedCustomer?.SyncToken === "string"
        ? deactivatedCustomer.SyncToken
        : existingLink.quickbooks_sync_token,
    realm_id: connection.realm_id || null,
    last_synced_hash: existingLink.last_synced_hash || null,
    last_direction: "medusa_delete_to_quickbooks",
    last_synced_at: new Date(),
    metadata: {
      ...((existingLink.metadata as Record<string, unknown> | null) || {}),
      quickbooks_active: false,
      deleted_in_medusa_at: new Date().toISOString(),
    },
  });

  return {
    skipped: false,
    medusa_customer_id: medusaCustomerId,
    quickbooks_customer_id: quickbooksCustomer.Id,
    direction: "medusa_to_quickbooks",
    status: "deactivated",
  };
}

export async function syncQuickbooksCustomersToMedusa(scope: ScopeLike) {
  const { quickbooksService, config, connection } =
    await getReadyQuickbooksConnection(scope);

  if (!connection) {
    return {
      connected: false,
      created: 0,
      updated: 0,
      skipped: 0,
      items: [] as Record<string, unknown>[],
    };
  }

  const medusaCustomers = await listMedusaCustomers(scope);
  const customerModuleService = scope.resolve(Modules.CUSTOMER);
  const quickbooksCustomers = await findQuickbooksCustomers(connection, config);

  const medusaById = new Map<string, Record<string, unknown>>();
  const medusaByEmail = new Map<string, Record<string, unknown>>();

  for (const customer of medusaCustomers) {
    if (typeof customer.id === "string") {
      medusaById.set(customer.id, customer);
    }

    const email = normalizeEmail(customer.email);

    if (email) {
      medusaByEmail.set(email, customer);
    }
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const items: Record<string, unknown>[] = [];

  for (const quickbooksCustomer of quickbooksCustomers) {
    try {
      const result = await syncOneQuickbooksCustomerToMedusa(scope, {
        quickbooksCustomer,
        quickbooksService,
        connection,
        config,
        customerModuleService,
        medusaById,
        medusaByEmail,
      });

      if (result.status === "created") {
        created++;
      } else if (result.status === "updated" || result.status === "linked") {
        updated++;
      } else {
        skipped++;
      }

      items.push(result);
    } catch (error) {
      failed++;
      const reason = extractQuickbooksErrorMessage(error);

      console.error(
        "[quickbooks-customer-sync] failed to sync from QuickBooks",
        {
          quickbooks_customer_id: quickbooksCustomer.Id,
          reason,
        },
      );

      items.push({
        quickbooks_customer_id: quickbooksCustomer.Id,
        status: "failed",
        reason,
      });
    }
  }

  return {
    connected: true,
    created,
    updated,
    skipped,
    failed,
    items,
  };
}

async function syncOneQuickbooksCustomerToMedusa(
  scope: ScopeLike,
  input: {
    quickbooksCustomer: Record<string, unknown>;
    quickbooksService: QuickbooksModuleService;
    connection: {
      realm_id?: string | null;
      access_token?: string | null;
      refresh_token?: string | null;
    };
    config: ReturnType<typeof getQuickbooksConfig>;
    customerModuleService: any;
    medusaById: Map<string, Record<string, unknown>>;
    medusaByEmail: Map<string, Record<string, unknown>>;
  },
) {
  const {
    quickbooksCustomer,
    quickbooksService,
    connection,
    config,
    customerModuleService,
    medusaById,
    medusaByEmail,
  } = input;

  const notes = parseQuickbooksNotes(quickbooksCustomer.Notes);
  const email = normalizeEmail(
    (quickbooksCustomer.PrimaryEmailAddr as Record<string, unknown> | undefined)
      ?.Address,
  );

  const existingLink =
    await quickbooksService.getCustomerLinkByQuickbooksCustomerId(
      String(quickbooksCustomer.Id),
    );
  const existingLinkMetadata = asRecord(existingLink?.metadata);
  const quickbooksHash = hashCustomerPayload(
    normalizeQuickbooksCustomerForSync(quickbooksCustomer),
  );

  if (
    existingLink?.last_synced_hash === quickbooksHash &&
    existingLink?.last_direction === "quickbooks_to_medusa"
  ) {
    return {
      quickbooks_customer_id: quickbooksCustomer.Id,
      status: "skipped",
      reason: "Already synced from QuickBooks.",
    };
  }

  if (
    quickbooksCustomer.Active === false &&
    typeof existingLinkMetadata?.deleted_in_medusa_at === "string"
  ) {
    return {
      quickbooks_customer_id: quickbooksCustomer.Id,
      status: "skipped",
      reason: "Inactive QuickBooks customer was already deleted in Medusa.",
    };
  }

  let medusaCustomer =
    (typeof notes?.medusa_id === "string"
      ? medusaById.get(notes.medusa_id)
      : null) ||
    (existingLink?.medusa_customer_id
      ? medusaById.get(existingLink.medusa_customer_id)
      : null) ||
    (email ? medusaByEmail.get(email) : null) ||
    null;

  const medusaInput = toMedusaCustomerInput(quickbooksCustomer);

  if (!medusaInput.email) {
    return {
      quickbooks_customer_id: quickbooksCustomer.Id,
      status: "skipped",
      reason: "QuickBooks customer has no email.",
    };
  }

  if (
    quickbooksCustomer.Active === false &&
    !medusaCustomer &&
    existingLink?.medusa_customer_id
  ) {
    return {
      quickbooks_customer_id: quickbooksCustomer.Id,
      status: "skipped",
      reason: "Inactive QuickBooks customer maps to a deleted Medusa customer.",
    };
  }

  let status: "created" | "updated" | "linked" = "created";

  if (medusaCustomer) {
    await customerModuleService.updateCustomers(medusaCustomer.id, medusaInput);
    medusaCustomer = {
      ...medusaCustomer,
      ...medusaInput,
    };
    status = notes?.medusa_id || existingLink ? "updated" : "linked";
  } else {
    medusaCustomer = await customerModuleService.createCustomers(medusaInput);
  }

  const resolvedMedusaCustomer = medusaCustomer as Record<string, unknown>;

  const normalizedMedusa = {
    ...resolvedMedusaCustomer,
    ...medusaInput,
  };

  await quickbooksService.upsertCustomerLink({
    medusa_customer_id: String(resolvedMedusaCustomer.id),
    quickbooks_customer_id: String(quickbooksCustomer.Id),
    quickbooks_sync_token:
      typeof quickbooksCustomer.SyncToken === "string"
        ? quickbooksCustomer.SyncToken
        : null,
    realm_id: connection.realm_id || null,
    last_synced_hash: quickbooksHash,
    last_direction: "quickbooks_to_medusa",
    last_synced_at: new Date(),
    metadata: {
      quickbooks_display_name: quickbooksCustomer.DisplayName || null,
    },
  });

  if (notes?.medusa_id !== resolvedMedusaCustomer.id) {
    await updateQuickbooksCustomer(
      connection,
      config,
      toQuickbooksCustomerPayload(normalizedMedusa, quickbooksCustomer, {
        metadataOnly: true,
      }),
    );
  }

  medusaById.set(String(resolvedMedusaCustomer.id), normalizedMedusa);
  medusaByEmail.set(normalizeEmail(normalizedMedusa.email), normalizedMedusa);

  return {
    quickbooks_customer_id: quickbooksCustomer.Id,
    medusa_customer_id: resolvedMedusaCustomer.id,
    status,
  };
}

export async function syncQuickbooksCustomerToMedusaById(
  scope: ScopeLike,
  quickbooksCustomerId: string,
) {
  const { quickbooksService, config, connection } =
    await getReadyQuickbooksConnection(scope);

  if (!connection) {
    return {
      connected: false,
      status: "skipped",
      reason: "QuickBooks is not connected.",
    };
  }

  const quickbooksCustomer = await getQuickbooksCustomer(
    connection,
    config,
    quickbooksCustomerId,
  );

  if (!quickbooksCustomer) {
    return {
      connected: true,
      status: "skipped",
      reason: "QuickBooks customer not found.",
      quickbooks_customer_id: quickbooksCustomerId,
    };
  }

  const medusaCustomers = await listMedusaCustomers(scope);
  const customerModuleService = scope.resolve(Modules.CUSTOMER);
  const medusaById = new Map<string, Record<string, unknown>>();
  const medusaByEmail = new Map<string, Record<string, unknown>>();

  for (const customer of medusaCustomers) {
    if (typeof customer.id === "string") {
      medusaById.set(customer.id, customer);
    }

    const email = normalizeEmail(customer.email);

    if (email) {
      medusaByEmail.set(email, customer);
    }
  }

  return {
    connected: true,
    ...(await syncOneQuickbooksCustomerToMedusa(scope, {
      quickbooksCustomer,
      quickbooksService,
      connection,
      config,
      customerModuleService,
      medusaById,
      medusaByEmail,
    })),
  };
}

export async function deleteQuickbooksCustomerInMedusa(
  scope: ScopeLike,
  quickbooksCustomerId: string,
) {
  const { quickbooksService, connection } =
    await getReadyQuickbooksConnection(scope);

  if (!connection) {
    return {
      connected: false,
      status: "skipped",
      reason: "QuickBooks is not connected.",
      quickbooks_customer_id: quickbooksCustomerId,
    };
  }

  const existingLink =
    await quickbooksService.getCustomerLinkByQuickbooksCustomerId(
      quickbooksCustomerId,
    );

  if (!existingLink?.medusa_customer_id) {
    return {
      connected: true,
      status: "skipped",
      reason:
        "No linked Medusa customer found for deleted QuickBooks customer.",
      quickbooks_customer_id: quickbooksCustomerId,
    };
  }

  const customerModuleService = scope.resolve(Modules.CUSTOMER);
  await customerModuleService.deleteCustomers(existingLink.medusa_customer_id);

  await quickbooksService.upsertCustomerLink({
    medusa_customer_id: existingLink.medusa_customer_id,
    quickbooks_customer_id: quickbooksCustomerId,
    quickbooks_sync_token: existingLink.quickbooks_sync_token || null,
    realm_id: existingLink.realm_id || null,
    last_synced_hash: existingLink.last_synced_hash || null,
    last_direction: "quickbooks_delete_to_medusa",
    last_synced_at: new Date(),
    metadata: {
      ...((existingLink.metadata as Record<string, unknown> | null) || {}),
      deleted_in_quickbooks_at: new Date().toISOString(),
    },
  });

  return {
    connected: true,
    status: "deleted",
    medusa_customer_id: existingLink.medusa_customer_id,
    quickbooks_customer_id: quickbooksCustomerId,
  };
}

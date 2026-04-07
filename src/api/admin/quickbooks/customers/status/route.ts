import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { QUICKBOOKS_MODULE } from "../../../../../modules/quickbooks"
import type QuickbooksModuleService from "../../../../../modules/quickbooks/service"
import {
  findQuickbooksCustomers,
  getBaseUrl,
  getQuickbooksConfig,
  isConnectionExpired,
  refreshOauthToken,
  toStoredConnection,
} from "../../../../../lib/quickbooks"

type QueryGraph = {
  graph: (input: {
    entity: string
    fields: string[]
    filters?: Record<string, unknown>
  }) => Promise<{ data?: Record<string, unknown>[] }>
}

const normalizeMedusaCustomer = (customer: Record<string, unknown>) => ({
  id: customer.id || null,
  email: customer.email || null,
  first_name: customer.first_name || null,
  last_name: customer.last_name || null,
  company_name: customer.company_name || null,
  phone: customer.phone || null,
  has_account: customer.has_account || null,
  created_at: customer.created_at || null,
  updated_at: customer.updated_at || null,
})

const normalizeQuickbooksCustomer = (customer: Record<string, unknown>) => ({
  id: customer.Id || null,
  sync_token: customer.SyncToken || null,
  display_name: customer.DisplayName || null,
  fully_qualified_name: customer.FullyQualifiedName || null,
  company_name: customer.CompanyName || null,
  given_name: customer.GivenName || null,
  family_name: customer.FamilyName || null,
  primary_email: (customer.PrimaryEmailAddr as Record<string, unknown> | undefined)
    ?.Address || null,
  primary_phone: (customer.PrimaryPhone as Record<string, unknown> | undefined)
    ?.FreeFormNumber || null,
  active: customer.Active ?? null,
  create_time: (customer.MetaData as Record<string, unknown> | undefined)?.CreateTime || null,
  update_time:
    (customer.MetaData as Record<string, unknown> | undefined)?.LastUpdatedTime || null,
})

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const config = getQuickbooksConfig(getBaseUrl(req))
  const quickbooksService: QuickbooksModuleService = req.scope.resolve(
    QUICKBOOKS_MODULE
  )
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as QueryGraph

  const medusaCustomersResponse = await query.graph({
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
  })

  const medusaCustomers = medusaCustomersResponse.data ?? []
  const medusaByEmail = new Map<string, Record<string, unknown>>()

  for (const customer of medusaCustomers) {
    const email =
      typeof customer.email === "string" ? customer.email.trim().toLowerCase() : ""

    if (email) {
      medusaByEmail.set(email, customer)
    }
  }

  if (!config.configured) {
    return res.status(200).json({
      configured: false,
      connected: false,
      missingKeys: config.missingKeys,
      environment: config.environment,
      medusa: {
        count: medusaCustomers.length,
        normalized: medusaCustomers.map(normalizeMedusaCustomer),
        raw: medusaCustomers,
      },
      quickbooks: {
        count: 0,
        normalized: [],
        raw: [],
      },
    })
  }

  let connection = await quickbooksService.getConnection()

  if (connection && connection.refresh_token && isConnectionExpired(connection)) {
    try {
      const refreshedToken = await refreshOauthToken(connection, config)

      connection = await quickbooksService.upsertConnection(
        toStoredConnection(refreshedToken, req.auth_context?.actor_id)
      )
    } catch (e) {
      return res.status(200).json({
        configured: true,
        connected: false,
        environment: config.environment,
        medusa: {
          count: medusaCustomers.length,
          normalized: medusaCustomers.map(normalizeMedusaCustomer),
          raw: medusaCustomers,
        },
        quickbooks: {
          count: 0,
          normalized: [],
          raw: [],
          error:
            e instanceof Error
              ? e.message
              : "Unable to refresh QuickBooks token for customers.",
        },
      })
    }
  }

  if (!connection?.access_token || !connection?.realm_id) {
    return res.status(200).json({
      configured: true,
      connected: false,
      environment: config.environment,
      medusa: {
        count: medusaCustomers.length,
        normalized: medusaCustomers.map(normalizeMedusaCustomer),
        raw: medusaCustomers,
      },
      quickbooks: {
        count: 0,
        normalized: [],
        raw: [],
      },
    })
  }

  try {
    const quickbooksCustomers = await findQuickbooksCustomers(connection, config)
    const normalizedQuickbooksCustomers = quickbooksCustomers.map(
      normalizeQuickbooksCustomer
    )

    const emailMatches = normalizedQuickbooksCustomers
      .map((customer) => {
        const email =
          typeof customer.primary_email === "string"
            ? customer.primary_email.trim().toLowerCase()
            : ""

        if (!email) {
          return null
        }

        const medusaCustomer = medusaByEmail.get(email)

        if (!medusaCustomer) {
          return null
        }

        return {
          email,
          medusa_customer_id: medusaCustomer.id || null,
          quickbooks_customer_id: customer.id || null,
          medusa_name: [medusaCustomer.first_name, medusaCustomer.last_name]
            .filter(Boolean)
            .join(" "),
          quickbooks_name:
            customer.display_name ||
            [customer.given_name, customer.family_name].filter(Boolean).join(" "),
        }
      })
      .filter(Boolean)

    return res.status(200).json({
      configured: true,
      connected: true,
      environment: connection.environment,
      realmId: connection.realm_id,
      medusa: {
        count: medusaCustomers.length,
        normalized: medusaCustomers.map(normalizeMedusaCustomer),
        raw: medusaCustomers,
      },
      quickbooks: {
        count: quickbooksCustomers.length,
        normalized: normalizedQuickbooksCustomers,
        raw: quickbooksCustomers,
      },
      matches: emailMatches,
    })
  } catch (e) {
    return res.status(200).json({
      configured: true,
      connected: true,
      environment: connection.environment,
      realmId: connection.realm_id,
      medusa: {
        count: medusaCustomers.length,
        normalized: medusaCustomers.map(normalizeMedusaCustomer),
        raw: medusaCustomers,
      },
      quickbooks: {
        count: 0,
        normalized: [],
        raw: [],
        error:
          e instanceof Error
            ? e.message
            : "Unable to fetch QuickBooks customers.",
      },
    })
  }
}

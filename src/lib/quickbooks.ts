import { createHmac, randomUUID, timingSafeEqual } from "crypto"
import type { Readable } from "stream"

const axios = require("node-quickbooks/node_modules/axios")
const FormData = require("form-data")
const OAuthClient = require("intuit-oauth")
const QuickBooks = require("node-quickbooks")

type QuickbooksEnvironment = "sandbox" | "production"

type TokenPayload = {
  token_type?: string
  access_token?: string
  refresh_token?: string
  expires_in?: number
  x_refresh_token_expires_in?: number
  realmId?: string
  scope?: string | string[]
  createdAt?: number
  [key: string]: unknown
}

type CreateOauthClientInput = {
  clientId: string
  clientSecret: string
  redirectUri: string
  environment: QuickbooksEnvironment
}

type SignedStatePayload = {
  actorId: string | null
  returnTo: string
  ts: number
}

export function getBaseUrl(req: {
  protocol?: string
  get?: (name: string) => string | undefined
  headers?: Record<string, string | string[] | undefined>
}) {
  const host =
    req.get?.("host") ||
    (typeof req.headers?.host === "string" ? req.headers.host : undefined)

  return `${req.protocol || "http"}://${host}`
}

export function getQuickbooksConfig(baseUrl?: string) {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID?.trim() || ""
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET?.trim() || ""
  const environment =
    (process.env.QUICKBOOKS_ENVIRONMENT?.trim() as QuickbooksEnvironment) ||
    "sandbox"
  const redirectUri =
    process.env.QUICKBOOKS_REDIRECT_URI?.trim() ||
    (baseUrl ? `${baseUrl}/admin/quickbooks/callback` : "")

  const missingKeys = ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET"].filter(
    (key) => !process.env[key]?.trim()
  )

  return {
    clientId,
    clientSecret,
    environment,
    redirectUri,
    configured: missingKeys.length === 0 && !!redirectUri,
    missingKeys,
  }
}

export function createOauthClient(input: CreateOauthClientInput) {
  return new OAuthClient({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    environment: input.environment,
    redirectUri: input.redirectUri,
    logging: process.env.QUICKBOOKS_LOGGING === "true",
  })
}

export function createAuthorizationUrl(
  client: typeof OAuthClient.prototype,
  state: string
) {
  return client.authorizeUri({
    scope: [
      OAuthClient.scopes.Accounting,
      OAuthClient.scopes.OpenId,
      OAuthClient.scopes.Profile,
      OAuthClient.scopes.Email,
    ],
    state,
  })
}

export function getStateSecret() {
  const secret =
    process.env.QUICKBOOKS_STATE_SECRET ||
    process.env.COOKIE_SECRET ||
    process.env.JWT_SECRET ||
    process.env.QUICKBOOKS_CLIENT_SECRET

  if (!secret) {
    throw new Error(
      "Missing QUICKBOOKS_STATE_SECRET, COOKIE_SECRET, JWT_SECRET, or QUICKBOOKS_CLIENT_SECRET."
    )
  }

  return secret
}

export function getWebhookVerifierToken() {
  const token =
    process.env.QUICKBOOKS_WEBHOOK_VERIFIER?.trim() ||
    process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN?.trim()

  if (!token) {
    throw new Error(
      "Missing QUICKBOOKS_WEBHOOK_VERIFIER or QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN."
    )
  }

  return token
}

export function signState(payload: SignedStatePayload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = createHmac("sha256", getStateSecret())
    .update(encodedPayload)
    .digest("base64url")

  return `${encodedPayload}.${signature}`
}

export function verifyState(state: string): SignedStatePayload {
  const [encodedPayload, providedSignature] = state.split(".")

  if (!encodedPayload || !providedSignature) {
    throw new Error("Invalid QuickBooks state.")
  }

  const expectedSignature = createHmac("sha256", getStateSecret())
    .update(encodedPayload)
    .digest("base64url")

  const expectedBuffer = Buffer.from(expectedSignature)
  const providedBuffer = Buffer.from(providedSignature)

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    throw new Error("Invalid QuickBooks state signature.")
  }

  const payload = JSON.parse(
    Buffer.from(encodedPayload, "base64url").toString("utf8")
  ) as SignedStatePayload

  if (Date.now() - payload.ts > 10 * 60 * 1000) {
    throw new Error("QuickBooks state has expired.")
  }

  return payload
}

export function tokenDates(token: TokenPayload) {
  const createdAt = token.createdAt || Date.now()

  return {
    createdAt,
    expiresAt:
      typeof token.expires_in === "number"
        ? new Date(createdAt + token.expires_in * 1000)
        : null,
    refreshTokenExpiresAt:
      typeof token.x_refresh_token_expires_in === "number"
        ? new Date(createdAt + token.x_refresh_token_expires_in * 1000)
        : null,
  }
}

export function toStoredConnection(token: TokenPayload, actorId?: string | null) {
  const dates = tokenDates(token)
  const scope =
    typeof token.scope === "string"
      ? { value: token.scope }
      : Array.isArray(token.scope)
        ? { values: token.scope }
        : token.scope && typeof token.scope === "object"
          ? (token.scope as Record<string, unknown>)
          : null

  return {
    environment:
      (process.env.QUICKBOOKS_ENVIRONMENT?.trim() as QuickbooksEnvironment) ||
      "sandbox",
    realm_id: token.realmId || null,
    access_token: token.access_token || null,
    refresh_token: token.refresh_token || null,
    token_type: token.token_type || null,
    scope,
    expires_at: dates.expiresAt,
    refresh_token_expires_at: dates.refreshTokenExpiresAt,
    raw_token: token,
    connected_at: new Date(),
    disconnected_at: null,
    updated_by: actorId ?? null,
  }
}

export function isConnectionExpired(connection: {
  expires_at?: Date | string | null
}) {
  if (!connection.expires_at) {
    return false
  }

  return new Date(connection.expires_at).getTime() <= Date.now() + 60 * 1000
}

export async function refreshOauthToken(
  connection: {
    access_token?: string | null
    refresh_token?: string | null
    token_type?: string | null
    raw_token?: Record<string, unknown> | null
  },
  config: ReturnType<typeof getQuickbooksConfig>
) {
  const oauthClient = createOauthClient(config)

  oauthClient.setToken({
    ...(connection.raw_token || {}),
    access_token: connection.access_token || undefined,
    refresh_token: connection.refresh_token || undefined,
    token_type: connection.token_type || undefined,
  })

  const authResponse = await oauthClient.refresh()

  return authResponse.getToken() as TokenPayload
}

export function createQuickbooksClient(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>
) {
  return new QuickBooks(
    config.clientId,
    config.clientSecret,
    connection.access_token,
    false,
    connection.realm_id,
    config.environment === "sandbox",
    process.env.QUICKBOOKS_DEBUG === "true",
    null,
    "2.0",
    connection.refresh_token
  )
}

export async function getCompanyInfo(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>
) {
  if (!connection.realm_id) {
    return null
  }

  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.getCompanyInfo(connection.realm_id, (error: Error, company: unknown) => {
      if (error) {
        reject(error)
        return
      }

      resolve((company as Record<string, unknown>) || null)
    })
  })
}

const asRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return null
}

const sanitizeQuickbooksCustomerForUpdate = (customer: Record<string, unknown>) => {
  const payload = {
    ...customer,
  }

  delete payload.MetaData
  delete payload.domain
  delete payload.sparse
  delete payload.FullyQualifiedName
  delete payload.Balance
  delete payload.BalanceWithJobs
  delete payload.CurrencyRef
  delete payload.TaxExemptionReasonId

  return payload
}

const sanitizeQuickbooksItemForUpdate = (item: Record<string, unknown>) => {
  const payload = {
    ...item,
  }

  delete payload.MetaData
  delete payload.domain
  delete payload.sparse
  delete payload.FullyQualifiedName
  delete payload.SubItem
  delete payload.Level
  delete payload.PrintGroupedItems
  delete payload.PrefVendorRef
  delete payload.PurchaseTaxIncluded
  delete payload.SalesTaxIncluded

  return payload
}

export async function updateCompanyInfo(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  payload: Record<string, unknown>
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.updateCompanyInfo(payload, (error: Error, company: unknown) => {
      if (error) {
        reject(error)
        return
      }

      resolve((company as Record<string, unknown>) || null)
    })
  })
}

type QuickbooksCustomerCriteria =
  | string
  | Record<string, unknown>
  | Array<Record<string, unknown>>
  | undefined

const asArray = <T>(value: T | T[] | null | undefined): T[] => {
  if (Array.isArray(value)) {
    return value
  }

  if (value === null || value === undefined) {
    return []
  }

  return [value]
}

const extractQueryItems = <T>(
  payload: unknown,
  key: string
): T[] => {
  const record = asRecord(payload)
  const queryResponse = asRecord(record?.QueryResponse)
  const items = queryResponse?.[key]

  return asArray(items as T | T[] | null | undefined)
}

export async function findQuickbooksCustomers(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  criteria?: QuickbooksCustomerCriteria
) {
  const client = createQuickbooksClient(connection, config)
  
  if (criteria !== undefined) {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      client.findCustomers(criteria, (error: Error, response: unknown) => {
        if (error) {
          reject(error)
          return
        }
        resolve(extractQueryItems<Record<string, unknown>>(response, "Customer"))
      })
    })
  }

  const allItems: Record<string, unknown>[] = []
  let startPosition = 1
  const maxResults = 100
  let done = false

  while (!done) {
    const batch = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      client.findCustomers({ offset: startPosition, limit: maxResults }, (error: Error, response: unknown) => {
        if (error) {
          reject(error)
          return
        }
        resolve(extractQueryItems<Record<string, unknown>>(response, "Customer"))
      })
    })

    if (batch.length === 0) {
      done = true
    } else {
      allItems.push(...batch)
      startPosition += batch.length
      if (batch.length < maxResults) {
        done = true
      }
    }
  }

  return allItems
}

export async function getQuickbooksCustomer(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  customerId: string
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.getCustomer(customerId, (error: Error, customer: unknown) => {
      if (error) {
        reject(error)
        return
      }

      resolve((customer as Record<string, unknown>) || null)
    })
  })
}

export async function createQuickbooksCustomer(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  payload: Record<string, unknown>
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.createCustomer(payload, (error: Error, customer: unknown) => {
      if (error) {
        reject(error)
        return
      }

      resolve((customer as Record<string, unknown>) || null)
    })
  })
}

export async function updateQuickbooksCustomer(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  payload: Record<string, unknown>
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.updateCustomer(payload, (error: Error, customer: unknown) => {
      if (error) {
        reject(error)
        return
      }

      resolve((customer as Record<string, unknown>) || null)
    })
  })
}

export async function deactivateQuickbooksCustomer(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  customer: Record<string, unknown>
) {
  if (!customer.Id || !customer.SyncToken) {
    return null
  }

  try {
    return await updateQuickbooksCustomer(connection, config, {
      Id: customer.Id,
      SyncToken: customer.SyncToken,
      Active: false,
      sparse: true,
    })
  } catch (error) {
    const fallbackPayload = sanitizeQuickbooksCustomerForUpdate(customer)

    return await updateQuickbooksCustomer(connection, config, {
      ...fallbackPayload,
      Id: customer.Id,
      SyncToken: customer.SyncToken,
      Active: false,
      sparse: true,
    })
  }
}

type QuickbooksItemCriteria =
  | string
  | Record<string, unknown>
  | Array<Record<string, unknown>>
  | undefined

type QuickbooksAccountCriteria =
  | string
  | Record<string, unknown>
  | Array<Record<string, unknown>>
  | undefined

type QuickbooksAttachableCriteria =
  | string
  | Record<string, unknown>
  | Array<Record<string, unknown>>
  | undefined

export async function findQuickbooksItems(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  criteria?: QuickbooksItemCriteria
) {
  const client = createQuickbooksClient(connection, config)

  if (criteria !== undefined) {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      client.findItems(criteria, (error: Error, response: unknown) => {
        if (error) {
          reject(error)
          return
        }
        resolve(extractQueryItems<Record<string, unknown>>(response, "Item"))
      })
    })
  }

  const allItems: Record<string, unknown>[] = []
  let startPosition = 1
  const maxResults = 100
  let done = false

  while (!done) {
    const batch = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      client.findItems({ offset: startPosition, limit: maxResults }, (error: Error, response: unknown) => {
        if (error) {
          reject(error)
          return
        }
        resolve(extractQueryItems<Record<string, unknown>>(response, "Item"))
      })
    })

    if (batch.length === 0) {
      done = true
    } else {
      allItems.push(...batch)
      startPosition += batch.length
      if (batch.length < maxResults) {
        done = true
      }
    }
  }

  return allItems
}

export async function findQuickbooksAccounts(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  criteria?: QuickbooksAccountCriteria
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const callback = (error: Error, accounts: unknown) => {
      if (error) {
        reject(error)
        return
      }

      resolve(extractQueryItems<Record<string, unknown>>(accounts, "Account"))
    }

    if (criteria === undefined) {
      client.findAccounts(callback)
      return
    }

    client.findAccounts(criteria, callback)
  })
}

export async function getQuickbooksAccount(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  accountId: string
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.getAccount(accountId, (error: Error, account: unknown) => {
      if (error) {
        reject(error)
        return
      }

      resolve((account as Record<string, unknown>) || null)
    })
  })
}

export async function getQuickbooksItem(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  itemId: string
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.getItem(itemId, (error: Error, item: unknown) => {
      if (error) {
        reject(error)
        return
      }

      resolve((item as Record<string, unknown>) || null)
    })
  })
}

export async function createQuickbooksItem(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  payload: Record<string, unknown>
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.createItem(payload, (error: Error, item: unknown) => {
      if (error) {
        reject(error)
        return
      }

      resolve((item as Record<string, unknown>) || null)
    })
  })
}

export async function updateQuickbooksItem(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  payload: Record<string, unknown>
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.updateItem(payload, (error: Error, item: unknown) => {
      if (error) {
        reject(error)
        return
      }

      resolve((item as Record<string, unknown>) || null)
    })
  })
}

export async function safeUpdateQuickbooksItem(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  existingItem: Record<string, unknown>,
  payload: Record<string, unknown>
) {
  try {
    return await updateQuickbooksItem(connection, config, payload)
  } catch (error) {
    const fallbackPayload = {
      ...sanitizeQuickbooksItemForUpdate(existingItem),
      ...payload,
    }

    return await updateQuickbooksItem(connection, config, fallbackPayload)
  }
}

export async function findQuickbooksAttachables(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  criteria?: QuickbooksAttachableCriteria
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const callback = (error: Error, attachables: unknown) => {
      if (error) {
        reject(error)
        return
      }

      resolve(extractQueryItems<Record<string, unknown>>(attachables, "Attachable"))
    }

    if (criteria === undefined) {
      client.findAttachables(callback)
      return
    }

    client.findAttachables(criteria, callback)
  })
}

export async function getQuickbooksAttachable(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  attachableId: string
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.getAttachable(attachableId, (error: Error, attachable: unknown) => {
      if (error) {
        reject(error)
        return
      }

      resolve((attachable as Record<string, unknown>) || null)
    })
  })
}

export async function updateQuickbooksAttachable(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  payload: Record<string, unknown>
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.updateAttachable(payload, (error: Error, attachable: unknown) => {
      if (error) {
        reject(error)
        return
      }

      resolve((attachable as Record<string, unknown>) || null)
    })
  })
}

export async function deleteQuickbooksAttachable(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  attachableIdOrEntity: string | Record<string, unknown>
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.deleteAttachable(
      attachableIdOrEntity,
      (error: Error, attachable: unknown) => {
        if (error) {
          reject(error)
          return
        }

        resolve((attachable as Record<string, unknown>) || null)
      }
    )
  })
}

export async function uploadQuickbooksFile(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  input: {
    filename: string
    contentType: string
    stream: Readable
    bytes?: Buffer
    entityType?: string
    entityId?: string
  }
) {
  const client = createQuickbooksClient(connection, config)

  const fileBytes = input.bytes ?? (await readStreamToBuffer(input.stream))
  const form = new FormData()

  form.append("file_content_01", fileBytes, {
    filename: input.filename,
    contentType: input.contentType,
    knownLength: fileBytes.length,
  })

  const contentLength = await new Promise<number>((resolve, reject) => {
    form.getLength((error: Error | null, length: number) => {
      if (error) {
        reject(error)
        return
      }

      resolve(length)
    })
  })

  try {
    const response = await axios({
      url: `${client.endpoint}${client.realmId}/upload`,
      method: "post",
      params: {
        minorversion: client.minorversion,
        format: "json",
      },
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${client.token}`,
        "User-Agent": "node-quickbooks: version 2.0.48",
        "Request-Id": randomUUID(),
        "Content-Length": contentLength,
      },
      maxContentLength: -1,
      maxBodyLength: -1,
      data: form,
    })

    const body = response.data
    const uploadedAttachable = Array.isArray(body)
      ? ((body[0]?.Attachable as Record<string, unknown> | undefined) ?? null)
      : ((body?.Attachable as Record<string, unknown> | undefined) ?? null)

    if (!uploadedAttachable) {
      return null
    }

    if (input.entityType && input.entityId) {
      const attachableId =
        typeof uploadedAttachable.Id === "string" ? uploadedAttachable.Id : null

      if (attachableId) {
        return await updateQuickbooksAttachable(connection, config, {
          Id: attachableId,
          SyncToken: "0",
          AttachableRef: [
            {
              EntityRef: {
                type: input.entityType,
                value: input.entityId,
              },
            },
          ],
          FileName: input.filename,
          ContentType: input.contentType,
        })
      }
    }

    return uploadedAttachable
  } catch (error) {
    const uploadError = error as Error & {
      response?: {
        status?: number
        data?: {
          Fault?: {
            Error?: Array<{
              Message?: string
              Detail?: string
              code?: string
            }>
            type?: string
          }
          time?: string
        }
      }
    }

    console.log("[quickbooks-upload] upload failed", {
      status: uploadError.response?.status ?? null,
      faultType: uploadError.response?.data?.Fault?.type ?? null,
      errors: uploadError.response?.data?.Fault?.Error ?? null,
      response: uploadError.response?.data ?? null,
      message: uploadError.message,
    })

    throw error
  }
}

async function readStreamToBuffer(stream: Readable) {
  const chunks: Buffer[] = []

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

export function verifyQuickbooksWebhookSignature(input: {
  rawBody: string | Buffer
  signature?: string | null
}) {
  const signature = input.signature?.trim()

  if (!signature) {
    return false
  }

  const expectedSignature = createHmac("sha256", getWebhookVerifierToken())
    .update(input.rawBody)
    .digest("base64")

  const expectedBuffer = Buffer.from(expectedSignature)
  const providedBuffer = Buffer.from(signature)

  if (expectedBuffer.length !== providedBuffer.length) {
    return false
  }

  return timingSafeEqual(expectedBuffer, providedBuffer)
}
export async function getQuickbooksSalesReceipt(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  id: string
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    client.getSalesReceipt(id, (error: Error, salesReceipt: unknown) => {
      if (error) {
        reject(error)
        return
      }
      resolve((salesReceipt as Record<string, unknown>) || null)
    })
  })
}
export async function findQuickbooksTaxRates(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  criteria?: any
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const callback = (error: Error, response: any) => {
      if (error) {
        reject(error)
        return
      }
      resolve(extractQueryItems<Record<string, unknown>>(response, "TaxRate"))
    }

    if (criteria === undefined) {
      client.findTaxRates(callback)
    } else {
      client.findTaxRates(criteria, callback)
    }
  })
}
export async function findQuickbooksTaxCodes(
  connection: {
    realm_id?: string | null
    access_token?: string | null
    refresh_token?: string | null
  },
  config: ReturnType<typeof getQuickbooksConfig>,
  criteria?: any
) {
  const client = createQuickbooksClient(connection, config)

  return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const callback = (error: Error, response: any) => {
      if (error) {
        reject(error)
        return
      }
      resolve(extractQueryItems<Record<string, unknown>>(response, "TaxCode"))
    }

    if (criteria === undefined) {
      client.findTaxCodes(callback)
    } else {
      client.findTaxCodes(criteria, callback)
    }
  })
}

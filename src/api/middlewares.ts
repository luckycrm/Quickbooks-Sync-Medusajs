import { defineMiddlewares } from "@medusajs/framework/http"

export default defineMiddlewares({
  routes: [
    {
      method: ["POST"],
      matcher: "/quickbooks/webhooks",
      bodyParser: {
        preserveRawBody: true,
      },
    },
  ],
})

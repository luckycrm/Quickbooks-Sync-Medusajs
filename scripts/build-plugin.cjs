const { Compiler } = require("@medusajs/framework/build-tools")
const { logger } = require("@medusajs/framework/logger")

async function main() {
  const directory = process.cwd()
  const compiler = new Compiler(directory, logger)
  const tsConfig = await compiler.loadTSConfigFile()

  if (!tsConfig) {
    process.exit(1)
  }

  const bundler = await import("@medusajs/admin-bundler")

  const backendOk = await compiler.buildPluginBackend(tsConfig)
  const adminOk = await compiler.buildPluginAdminExtensions(bundler)

  process.exit(backendOk && adminOk ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

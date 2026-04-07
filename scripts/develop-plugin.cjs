const path = require("path")
const chokidar = require("chokidar")
const swcCore = require("@swc/core")
const { execFile } = require("child_process")
const { Compiler } = require("@medusajs/framework/build-tools")
const { logger } = require("@medusajs/framework/logger")

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (stdout) {
        process.stdout.write(stdout)
      }

      if (stderr) {
        process.stderr.write(stderr)
      }

      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

async function transformFile(filePath) {
  const output = await swcCore.transformFile(filePath, {
    sourceMaps: "inline",
    module: {
      type: "commonjs",
      strictMode: true,
      noInterop: false,
    },
    jsc: {
      externalHelpers: false,
      target: "es2021",
      parser: {
        syntax: "typescript",
        tsx: true,
        decorators: true,
        dynamicImport: true,
      },
      transform: {
        legacyDecorator: true,
        decoratorMetadata: true,
        react: {
          throwIfNamespace: false,
          useBuiltins: false,
          pragma: "React.createElement",
          pragmaFrag: "React.Fragment",
          importSource: "react",
          runtime: "automatic",
        },
      },
      keepClassNames: true,
      baseUrl: process.cwd(),
    },
  })

  return output.code
}

async function main() {
  const directory = process.cwd()
  const compiler = new Compiler(directory, logger)
  const tsConfig = await compiler.loadTSConfigFile()

  if (!tsConfig) {
    process.exit(1)
  }

  const bundler = await import("@medusajs/admin-bundler")
  const yalcBin = path.join(path.dirname(require.resolve("yalc")), "yalc.js")

  let publishing = false
  let queuedPublish = false
  let rebuildingAdmin = false
  let queuedAdmin = false

  const publish = async () => {
    if (publishing) {
      queuedPublish = true
      return
    }

    publishing = true

    try {
      await execFileAsync(process.execPath, [yalcBin, "publish", "--push", "--no-scripts"], {
        cwd: directory,
      })
    } finally {
      publishing = false

      if (queuedPublish) {
        queuedPublish = false
        await publish()
      }
    }
  }

  const rebuildAdmin = async () => {
    if (rebuildingAdmin) {
      queuedAdmin = true
      return
    }

    rebuildingAdmin = true

    try {
      const ok = await compiler.buildPluginAdminExtensions(bundler)

      if (ok) {
        await publish()
      }
    } finally {
      rebuildingAdmin = false

      if (queuedAdmin) {
        queuedAdmin = false
        await rebuildAdmin()
      }
    }
  }

  const backendOk = await compiler.buildPluginBackend(tsConfig)
  const adminOk = await compiler.buildPluginAdminExtensions(bundler)

  if (!backendOk || !adminOk) {
    process.exit(1)
  }

  await publish()

  await compiler.developPluginBackend(transformFile, async () => {
    await publish()
  })

  const adminWatcher = chokidar.watch(["src/admin"], {
    ignoreInitial: true,
    cwd: directory,
    ignored: [/(^|[\\/])\../, "node_modules", ".medusa"],
  })

  const onAdminChange = async (file) => {
    logger.info(`${file} updated: Republishing admin changes`)
    await rebuildAdmin()
  }

  adminWatcher.on("add", onAdminChange)
  adminWatcher.on("change", onAdminChange)
  adminWatcher.on("unlink", onAdminChange)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

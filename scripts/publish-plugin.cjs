const path = require("path")
const { execFile } = require("child_process")

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

async function main() {
  const yalcBin = path.join(path.dirname(require.resolve("yalc")), "yalc.js")

  await execFileAsync(process.execPath, ["scripts/build-plugin.cjs"], {
    cwd: process.cwd(),
  })

  await execFileAsync(process.execPath, [yalcBin, "publish", "--push"], {
    cwd: process.cwd(),
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

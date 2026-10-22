// electron-builder afterPack hook.
//
// Without a "Developer ID Application" certificate electron-builder skips
// signing entirely, leaving the renamed Electron binary with a linker-signed
// signature that doesn't seal the app resources — Apple Silicon refuses to
// launch such bundles (SIGKILL at exec). Ad-hoc deep-signing makes the
// bundle launchable locally and on other arm64 Macs (after the usual
// Gatekeeper "Open Anyway" override for unnotarized apps, see README).
//
// When real signing is configured (CSC_LINK / CSC_NAME), this hook steps
// aside so it never clobbers a Developer ID signature.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_NAME) return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}

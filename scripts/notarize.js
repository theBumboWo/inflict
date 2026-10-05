#!/usr/bin/env node
/**
 * notarize.js — afterSign hook placeholder for future macOS notarization / Windows code signing.
 *
 * electron-builder calls this script after signing each build artifact.
 * Currently a no-op. When code signing is configured, implement the appropriate
 * platform-specific signing steps here (e.g., `electron-notarize` for macOS,
 * or EV certificate signing for Windows to suppress SmartScreen warnings).
 *
 * Known limitation: Without a valid code-signing certificate, Windows will show
 * a SmartScreen warning on first run of the unsigned installer.
 *
 * @param {import('electron-builder').AfterSignContext} context
 */
exports.default = async function notarize(context) {
  // TODO: Add code signing / notarization steps when certificates are available.
  // Example for macOS notarization with electron-notarize:
  //   const { notarize } = require('@electron/notarize');
  //   await notarize({ appBundleId: 'com.keywallet.app', appPath: context.appOutDir, ... });
  //
  // Example for Windows EV certificate via signtool:
  //   execSync(`signtool sign /tr http://timestamp.sectigo.com /td sha256 /fd sha256 "${exePath}"`);
};

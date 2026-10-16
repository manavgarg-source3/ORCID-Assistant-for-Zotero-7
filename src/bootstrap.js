/**
 * ORCID Assistant for Zotero 7+
 * bootstrap.js - Plugin Lifecycle Entry Point
 *
 * Implements the mandatory Gecko/Zotero restartless lifecycle hooks:
 * - install
 * - startup
 * - shutdown
 * - uninstall
 * - onMainWindowLoad
 * - onMainWindowUnload
 */

var ORCIDAssistant;

function log(msg) {
  if (typeof Zotero !== "undefined" && typeof Zotero.debug === "function") {
    Zotero.debug(`ORCID Assistant [bootstrap]: ${msg}`);
  }
}

/**
 * Called when the add-on is installed or updated.
 */
function install(data, reason) {
  log(`Plugin installed (reason: ${reason})`);
}

/**
 * Called when the add-on is started (at application launch or on enable).
 */
async function startup({ id, version, rootURI }, reason) {
  log(`Plugin starting up (version: ${version}, reason: ${reason})`);
  try {
    // Load main plugin logic in the privileged scope
    Services.scriptloader.loadSubScript(rootURI + "orcid-assistant.js");
    ORCIDAssistant.init({ id, version, rootURI });

    // Register API-level hooks (like MenuManager) immediately so they are
    // ready even before any main window finishes rendering its DOM
    ORCIDAssistant.addToAllWindows();

    // If starting on cold application launch, wait until Zotero UI is ready
    // before performing window DOM attachments
    if (typeof Zotero !== "undefined") {
      if (Zotero.initializationPromise) {
        await Zotero.initializationPromise;
      }
      if (Zotero.uiReadyPromise) {
        await Zotero.uiReadyPromise;
      }
    }

    // Re-verify window attachment once UI is guaranteed ready
    ORCIDAssistant.addToAllWindows();
    await ORCIDAssistant.main();
    log("Plugin startup finished successfully.");
  } catch (err) {
    if (typeof Zotero !== "undefined" && typeof Zotero.logError === "function") {
      Zotero.logError(err);
    }
    log(`Startup error: ${err?.stack || err?.message || err}`);
  }
}

/**
 * Called when a new main window is opened.
 */
function onMainWindowLoad({ window }) {
  log("Main window loaded hook triggered.");
  try {
    if (ORCIDAssistant && typeof ORCIDAssistant.addToWindow === "function") {
      ORCIDAssistant.addToWindow(window);
    }
  } catch (err) {
    log(`onMainWindowLoad error: ${err}`);
  }
}

/**
 * Called when an existing main window is closed.
 */
function onMainWindowUnload({ window }) {
  log("Main window unloaded hook triggered.");
  try {
    if (ORCIDAssistant && typeof ORCIDAssistant.removeFromWindow === "function") {
      ORCIDAssistant.removeFromWindow(window);
    }
  } catch (err) {
    log(`onMainWindowUnload error: ${err}`);
  }
}

/**
 * Called when the add-on is shut down (on disable, uninstall, or application exit).
 * Must cleanly unregister all UI elements, event listeners, and resources.
 */
function shutdown(data, reason) {
  log(`Plugin shutting down (reason: ${reason})`);
  try {
    if (ORCIDAssistant && typeof ORCIDAssistant.removeFromAllWindows === "function") {
      ORCIDAssistant.removeFromAllWindows();
    }
  } catch (err) {
    log(`Shutdown cleanup error: ${err}`);
  }
  ORCIDAssistant = undefined;
  log("Plugin shutdown completed.");
}

/**
 * Called when the add-on is uninstalled.
 */
function uninstall(data, reason) {
  log(`Plugin uninstalled (reason: ${reason})`);
}

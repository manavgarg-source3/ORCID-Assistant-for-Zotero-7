/**
 * ORCID Assistant for Zotero 7+
 * Core Plugin Implementation
 */

var ORCIDAssistant = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,
  addedElementIDs: [],
  menuManagerToolsID: null,
  menuManagerContextID: null,

  /**
   * Initialize plugin state.
   */
  init({ id, version, rootURI }) {
    if (this.initialized) return;
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this.initialized = true;
    this.log(`Initialized version ${version}`);
  },

  /**
   * Helper logger using Zotero.debug.
   */
  log(msg) {
    if (typeof Zotero !== "undefined" && typeof Zotero.debug === "function") {
      Zotero.debug(`ORCID Assistant: ${msg}`);
    }
  },

  /**
   * Helper error logger using Zotero.logError.
   */
  logError(err) {
    if (typeof Zotero !== "undefined" && typeof Zotero.logError === "function") {
      Zotero.logError(err);
    } else {
      this.log(`ERROR: ${err?.stack || err?.message || err}`);
    }
  },

  /**
   * Inject UI elements into a specific Zotero window.
   */
  addToWindow(window) {
    try {
      let doc = window.document;
      if (!doc) return;

      // Register Fluent localization strings if supported
      if (window.MozXULElement && typeof window.MozXULElement.insertFTLIfNeeded === "function") {
        try {
          window.MozXULElement.insertFTLIfNeeded("orcid-assistant.ftl");
        } catch (ftlError) {
          this.log(`Note loading Fluent FTL: ${ftlError.message}`);
        }
      }

      const menuItemId = "orcid-assistant-tools-menuitem";

      // Prevent duplicate insertion if already in window
      if (doc.getElementById(menuItemId) || doc.querySelector(".orcid-assistant-tools-menu")) {
        return;
      }

      let toolsPopup = doc.getElementById("menu_ToolsPopup");
      if (!toolsPopup) {
        // Document may still be parsing; listen for load events
        if (doc.readyState !== "complete") {
          window.addEventListener("DOMContentLoaded", () => this.addToWindow(window), { once: true });
          window.addEventListener("load", () => this.addToWindow(window), { once: true });
        }
        return;
      }

      // Add direct fallback menuitem if MenuManager hasn't rendered it
      let menuitem = doc.createXULElement
        ? doc.createXULElement("menuitem")
        : doc.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "menuitem");

      menuitem.id = menuItemId;
      menuitem.setAttribute("label", "ORCID Assistant");
      menuitem.setAttribute("data-l10n-id", "orcid-assistant-menu-item");

      menuitem.addEventListener("command", (event) => {
        try {
          this.onMenuItemCommand(window);
        } catch (cmdErr) {
          this.logError(cmdErr);
        }
      });

      toolsPopup.appendChild(menuitem);
      this.storeAddedElement(menuItemId);
      this.log(`Successfully attached Tools menu item to window (${window.location?.href || "main"})`);
    } catch (e) {
      this.logError(e);
    }
  },

  /**
   * Inject UI elements into all open Zotero windows and register official API hooks.
   */
  addToAllWindows() {
    try {
      if (typeof Zotero === "undefined") return;

      // 1. Register with Zotero.MenuManager for the menubar Tools menu (Zotero 7+ official API)
      if (Zotero.MenuManager && typeof Zotero.MenuManager.registerMenu === "function") {
        if (!this.menuManagerToolsID) {
          try {
            this.menuManagerToolsID = Zotero.MenuManager.registerMenu({
              menuID: "orcid-assistant-tools-menu",
              pluginID: this.id,
              target: "main/menubar/tools",
              menus: [
                {
                  menuType: "menuitem",
                  l10nID: "orcid-assistant-menu-item",
                  onShowing: (event, context) => {
                    try {
                      context.menuElem?.setAttribute("label", "ORCID Assistant");
                    } catch (e) {}
                  },
                  onCommand: (event, context) => {
                    let win = typeof Zotero.getMainWindow === "function" ? Zotero.getMainWindow() : null;
                    this.onMenuItemCommand(win);
                  }
                }
              ]
            });
            this.log(`Registered Tools menu via Zotero.MenuManager (regID: ${this.menuManagerToolsID})`);
          } catch (menuErr) {
            this.log(`Zotero.MenuManager Tools registration note: ${menuErr.message}`);
          }
        }

        // 2. Register with Zotero.MenuManager for library context menu
        if (!this.menuManagerContextID) {
          try {
            this.menuManagerContextID = Zotero.MenuManager.registerMenu({
              menuID: "orcid-assistant-item-context-menu",
              pluginID: this.id,
              target: "main/library/item",
              menus: [
                {
                  menuType: "menuitem",
                  l10nID: "orcid-assistant-menu-item",
                  onShowing: (event, context) => {
                    try {
                      context.menuElem?.setAttribute("label", "ORCID Assistant");
                    } catch (showErr) {}
                  },
                  onCommand: (event, context) => {
                    try {
                      let win = typeof Zotero.getMainWindow === "function" ? Zotero.getMainWindow() : null;
                      this.onMenuItemCommand(win);
                    } catch (ctxCmdErr) {
                      this.logError(ctxCmdErr);
                    }
                  }
                }
              ]
            });
            this.log(`Registered context menu via Zotero.MenuManager (regID: ${this.menuManagerContextID})`);
          } catch (menuErr) {
            this.log(`Zotero.MenuManager Context registration note: ${menuErr.message}`);
          }
        }
      }

      // 3. Attach to currently open windows as fallback / immediate availability
      let windows = typeof Zotero.getMainWindows === "function" ? Zotero.getMainWindows() : [];
      for (let win of windows) {
        if (!win.ZoteroPane) continue;
        this.addToWindow(win);
      }
    } catch (e) {
      this.logError(e);
    }
  },

  /**
   * Track element IDs for safe cleanup on shutdown.
   */
  storeAddedElement(elementId) {
    if (!this.addedElementIDs.includes(elementId)) {
      this.addedElementIDs.push(elementId);
    }
  },

  /**
   * Remove UI elements and references from a single window.
   */
  removeFromWindow(window) {
    try {
      let doc = window.document;
      if (!doc) return;

      for (let id of this.addedElementIDs) {
        let el = doc.getElementById(id);
        if (el) {
          el.remove();
          this.log(`Removed UI element: ${id}`);
        }
      }

      let ftlLink = doc.querySelector('[href="orcid-assistant.ftl"]');
      if (ftlLink) {
        ftlLink.remove();
      }
    } catch (e) {
      this.logError(e);
    }
  },

  /**
   * Remove UI elements from all windows and unregister official API hooks.
   */
  removeFromAllWindows() {
    try {
      // 1. Unregister Zotero.MenuManager hooks if registered
      if (this.menuManagerToolsID && Zotero.MenuManager && typeof Zotero.MenuManager.unregisterMenu === "function") {
        try {
          Zotero.MenuManager.unregisterMenu(this.menuManagerToolsID);
          this.log(`Unregistered MenuManager tools hook: ${this.menuManagerToolsID}`);
        } catch (unregErr) {
          this.log(`Error unregistering tools menu: ${unregErr.message}`);
        }
        this.menuManagerToolsID = null;
      }

      if (this.menuManagerContextID && Zotero.MenuManager && typeof Zotero.MenuManager.unregisterMenu === "function") {
        try {
          Zotero.MenuManager.unregisterMenu(this.menuManagerContextID);
          this.log(`Unregistered MenuManager context hook: ${this.menuManagerContextID}`);
        } catch (unregErr) {
          this.log(`Error unregistering context menu: ${unregErr.message}`);
        }
        this.menuManagerContextID = null;
      }

      // 2. Remove DOM elements from all main windows
      if (typeof Zotero !== "undefined" && typeof Zotero.getMainWindows === "function") {
        let windows = Zotero.getMainWindows();
        for (let win of windows) {
          if (!win.ZoteroPane) continue;
          this.removeFromWindow(win);
        }
      }

      this.addedElementIDs = [];
      this.log("Cleanup completed for all windows.");
    } catch (e) {
      this.logError(e);
    }
  },

  /**
   * Callback when menu item is clicked.
   */
  onMenuItemCommand(window) {
    this.log("Menu entry clicked by user.");
    this.showRunningDialog(window);
  },

  /**
   * Display confirmation dialog without external networking or publication modification.
   */
  showRunningDialog(window) {
    try {
      const title = "ORCID Assistant";
      const message = "ORCID Assistant is running.";

      // 1. Preferred method: XPCOM Services.prompt.alert
      if (typeof Services !== "undefined" && Services.prompt && typeof Services.prompt.alert === "function") {
        Services.prompt.alert(window || null, title, message);
        return;
      }

      // 2. Fallback: DOM window.alert
      if (window && typeof window.alert === "function") {
        window.alert(message);
        return;
      }

      // 3. Fallback: Zotero debug log
      this.log(message);
    } catch (e) {
      this.logError(e);
    }
  },

  /**
   * Main entry point called after startup initialization.
   */
  async main() {
    this.log("ORCID Assistant main() completed readiness check.");
  }
};

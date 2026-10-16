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
  helperUrl: "http://127.0.0.1:23125",
  fetchImpl: null,

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
   * Resolve helper service base URL from preferences or default.
   */
  getHelperUrl() {
    if (typeof Zotero !== "undefined" && Zotero.Prefs && typeof Zotero.Prefs.get === "function") {
      try {
        let prefUrl = Zotero.Prefs.get("extensions.orcid-assistant.helperUrl", true);
        if (prefUrl) return prefUrl;
      } catch (e) {}
    }
    return this.helperUrl || "http://127.0.0.1:23125";
  },

  /**
   * Validate and normalize an ORCID iD string.
   * Strips URI prefixes and verifies ISO 7064 MOD 11-2 check digit.
   */
  validateAndNormalizeOrcid(rawOrcid) {
    if (typeof rawOrcid !== "string") {
      return { valid: false, error: "ORCID iD must be a string." };
    }
    let trimmed = rawOrcid.trim();
    if (!trimmed) {
      return { valid: false, error: "ORCID iD cannot be empty." };
    }

    // Strip URL prefixes if user pasted full URL
    const cleaned = trimmed.replace(/^https?:\/\/(?:sandbox\.)?orcid\.org\//i, "");

    // Must match 16 characters in groups of 4 with hyphens
    const match = cleaned.match(/^([0-9]{4})-([0-9]{4})-([0-9]{4})-([0-9]{3}[0-9Xx])$/);
    if (!match) {
      return {
        valid: false,
        error: `Invalid ORCID iD format: "${cleaned}". Expected 16 digits formatted as 0000-0000-0000-0000 (e.g., 0000-0002-1825-0097).`
      };
    }

    // ISO 7064 MOD 11-2 check digit validation
    const digits = cleaned.replace(/-/g, "");
    let total = 0;
    for (let i = 0; i < 15; i++) {
      const digit = parseInt(digits[i], 10);
      total = (total + digit) * 2;
    }
    const remainder = total % 11;
    const result = (12 - remainder) % 11;
    const expectedCheckChar = result === 10 ? "X" : String(result);
    const actualCheckChar = digits[15].toUpperCase();

    if (expectedCheckChar !== actualCheckChar) {
      return {
        valid: false,
        error: `Invalid ORCID check digit for "${cleaned}". Expected '${expectedCheckChar}', got '${actualCheckChar}'. Check for mistyped digits.`
      };
    }

    return {
      valid: true,
      orcid: cleaned.toUpperCase()
    };
  },

  /**
   * Fetch public works from the local Node.js helper service.
   * Helper service runs on 127.0.0.1 and securely proxies requests to the ORCID API.
   */
  async fetchWorksFromHelper(orcid) {
    const helperUrl = this.getHelperUrl();
    const endpoint = `${helperUrl}/api/works?orcid=${encodeURIComponent(orcid)}`;
    this.log(`Fetching public works for ${orcid} from helper at ${endpoint}`);

    const fetchFn = this.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!fetchFn) {
      return {
        success: false,
        code: "NO_FETCH",
        error: "Global fetch API is not available in current environment."
      };
    }

    let controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timeoutId = controller ? setTimeout(() => controller.abort(), 10000) : null;

    try {
      const response = await fetchFn(endpoint, {
        method: "GET",
        headers: {
          "Accept": "application/json"
        },
        signal: controller ? controller.signal : undefined
      });

      const data = await response.json();
      return data;
    } catch (err) {
      if (err.name === "AbortError") {
        return {
          success: false,
          code: "TIMEOUT",
          error: "Connection to local helper service timed out after 10 seconds."
        };
      }
      return {
        success: false,
        code: "NETWORK_ERROR",
        error: `Could not connect to helper service at ${helperUrl}. Please verify the helper service is running on 127.0.0.1 (run: npm run helper).`
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  },

  /**
   * Format fetched works into a clean, read-only preview text.
   */
  formatWorksPreview(data) {
    const payload = data?.data || data || {};
    const orcid = payload.orcid || data?.orcid || "N/A";
    const total = payload.totalWorks ?? data?.totalWorks ?? (payload.works?.length || 0);
    const works = Array.isArray(payload.works) ? payload.works : (Array.isArray(data?.works) ? data.works : []);

    let lines = [];
    lines.push("==================================================");
    lines.push("           ORCID PUBLIC WORKS PREVIEW            ");
    lines.push("==================================================");
    lines.push(`ORCID iD:    ${orcid}`);
    lines.push(`Total Works: ${total}`);
    lines.push("--------------------------------------------------");

    if (works.length === 0) {
      lines.push("No public works found for this ORCID profile.");
    } else {
      const previewLimit = Math.min(works.length, 10);
      for (let i = 0; i < previewLimit; i++) {
        const w = works[i];
        lines.push(`[${i + 1}] Title: ${w.title || "(Untitled)"}`);
        lines.push(`    Year:  ${w.year || "Not specified"}`);
        lines.push(`    DOI:   ${w.doi || "None"}`);
        lines.push(`    Type:  ${w.type || "work"}`);
        if (w.journalTitle) {
          lines.push(`    Venue: ${w.journalTitle}`);
        }
        lines.push("");
      }
      if (works.length > previewLimit) {
        lines.push(`... and ${works.length - previewLimit} more public works (total: ${total}).`);
      }
    }

    lines.push("==================================================");
    lines.push("READ-ONLY PREVIEW: No items were imported, modified,");
    lines.push("or deleted in your Zotero library.");
    lines.push("==================================================");

    return lines.join("\n");
  },

  /**
   * Interactive UI flow: prompt for ORCID iD, query helper, and display preview.
   */
  async promptFetchPublicWorks(window, initialValue = "") {
    let promptService = (typeof Services !== "undefined" && Services.prompt) ? Services.prompt : null;

    if (!promptService || typeof promptService.prompt !== "function") {
      this.showRunningDialog(window);
      return;
    }

    let currentInput = initialValue || "";

    while (true) {
      let inputVal = { value: currentInput };
      let checkVal = { value: false };
      let confirmed = promptService.prompt(
        window || null,
        "ORCID Assistant - Fetch Public Works",
        "ORCID Assistant is running.\n\nEnter an ORCID iD to preview public works:\n(e.g., 0000-0002-1825-0097 or https://orcid.org/0000-0002-1825-0097)",
        inputVal,
        null,
        checkVal
      );

      if (!confirmed) {
        this.log("Fetch Public Works prompt cancelled by user.");
        return;
      }

      currentInput = (inputVal.value || "").trim();
      if (!currentInput) {
        let retryEmpty = promptService.confirm
          ? promptService.confirm(
              window || null,
              "ORCID Assistant",
              "No ORCID iD was entered.\n\nWould you like to try again?"
            )
          : false;
        if (retryEmpty) continue;
        return;
      }

      // Validate format & check digit
      let validation = this.validateAndNormalizeOrcid(currentInput);
      if (!validation.valid) {
        let retryInvalid = promptService.confirm
          ? promptService.confirm(
              window || null,
              "ORCID Assistant - Invalid Identifier",
              `${validation.error}\n\nWould you like to correct the ORCID iD and try again?`
            )
          : false;
        if (retryInvalid) continue;
        return;
      }

      const normalizedOrcid = validation.orcid;
      this.log(`Initiating public works fetch for ${normalizedOrcid}...`);

      let result = await this.fetchWorksFromHelper(normalizedOrcid);

      if (!result.success) {
        let errorMsg = result.error || "An unknown error occurred while contacting the helper service.";
        if (result.code === "MISSING_CREDENTIALS") {
          errorMsg = "ORCID API credentials are not configured in the helper service.\n\n" +
            "To configure:\n" +
            "1. Copy .env.example to .env in the project directory.\n" +
            "2. Add your ORCID_CLIENT_ID and ORCID_CLIENT_SECRET.\n" +
            "3. Start or restart the helper service: npm run helper";
        } else if (result.code === "NETWORK_ERROR") {
          errorMsg = `Could not connect to helper service at ${this.getHelperUrl()}.\n\n` +
            "Please make sure the local helper service is running:\n" +
            "  npm run helper";
        } else if (result.code === "RECORD_NOT_FOUND") {
          errorMsg = `ORCID record '${normalizedOrcid}' was not found in the public ORCID registry (404).\n\nPlease verify the identifier.`;
        }

        let retryAfterError = promptService.confirm
          ? promptService.confirm(
              window || null,
              "ORCID Assistant - Fetch Error",
              `${errorMsg}\n\nWould you like to try another ORCID iD?`
            )
          : false;
        if (retryAfterError) continue;
        return;
      }

      // Success: Display read-only preview
      const previewText = this.formatWorksPreview(result);
      const totalCount = result.totalWorks ?? result.data?.totalWorks ?? 0;
      if (typeof promptService.alert === "function") {
        promptService.alert(
          window || null,
          `ORCID Public Works Preview (${totalCount} works found)`,
          previewText
        );
      }

      // Ask if user wants to fetch for another ORCID iD
      let fetchAnother = promptService.confirm
        ? promptService.confirm(
            window || null,
            "ORCID Assistant",
            "Would you like to fetch public works for another ORCID iD?"
          )
        : false;

      if (fetchAnother) {
        currentInput = "";
        continue;
      }

      return;
    }
  },

  /**
   * Callback when menu item is clicked.
   */
  onMenuItemCommand(window) {
    this.log("Menu entry clicked by user.");
    if (typeof Services !== "undefined" && Services.prompt && typeof Services.prompt.prompt === "function") {
      this.promptFetchPublicWorks(window).catch(err => this.logError(err));
    } else {
      this.showRunningDialog(window);
    }
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

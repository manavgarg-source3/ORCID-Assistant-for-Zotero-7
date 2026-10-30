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
  mockLibraryItems: null,

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
      const batchMenuItemId = "orcid-assistant-tools-batch-menuitem";

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

      // 1. Add direct Tools menu item: Single ORCID import
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

      // 2. Add direct Tools menu item: Batch CSV & Group import
      let batchMenuItem = doc.createXULElement
        ? doc.createXULElement("menuitem")
        : doc.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "menuitem");

      batchMenuItem.id = batchMenuItemId;
      batchMenuItem.setAttribute("label", "ORCID Assistant — Batch CSV Import...");
      batchMenuItem.setAttribute("data-l10n-id", "orcid-assistant-menu-batch-item");

      batchMenuItem.addEventListener("command", (event) => {
        try {
          this.onBatchMenuItemCommand(window);
        } catch (cmdErr) {
          this.logError(cmdErr);
        }
      });

      toolsPopup.appendChild(batchMenuItem);
      this.storeAddedElement(batchMenuItemId);

      this.log(`Successfully attached Tools menu items to window (${window.location?.href || "main"})`);
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
                },
                {
                  menuType: "menuitem",
                  l10nID: "orcid-assistant-menu-batch-item",
                  onShowing: (event, context) => {
                    try {
                      context.menuElem?.setAttribute("label", "ORCID Assistant — Batch CSV Import...");
                    } catch (e) {}
                  },
                  onCommand: (event, context) => {
                    let win = typeof Zotero.getMainWindow === "function" ? Zotero.getMainWindow() : null;
                    this.onBatchMenuItemCommand(win);
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

      let modal = doc.getElementById("orcid-assistant-modal-overlay");
      if (modal) {
        modal.remove();
        this.log("Removed active ORCID Assistant modal dialog.");
      }

      let batchModal = doc.getElementById("orcid-assistant-batch-modal-overlay");
      if (batchModal) {
        batchModal.remove();
        this.log("Removed active ORCID Assistant batch modal dialog.");
      }

      let dupReportModal = doc.getElementById("orcid-duplicate-report-overlay");
      if (dupReportModal) {
        dupReportModal.remove();
        this.log("Removed active duplicate report popup.");
      }

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
   * Normalize a DOI string for comparison.
   * Strips URL prefixes (https://doi.org/, http://dx.doi.org/), 'doi:' prefix,
   * trailing punctuation, and normalizes to lowercase.
   */
  normalizeDoi(doi) {
    if (typeof doi !== "string") return null;
    let d = doi.trim();
    if (!d) return null;
    d = d.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    d = d.replace(/^doi:\s*/i, "");
    d = d.replace(/[/\s.]+$/, "");
    d = d.toLowerCase();
    return d.length > 0 ? d : null;
  },

  /**
   * Normalize a publication title for fuzzy matching.
   * Lowercases, removes HTML tags, strips punctuation, and collapses whitespace.
   */
  normalizeTitle(title) {
    if (typeof title !== "string") return "";
    let t = title.toLowerCase();
    t = t.replace(/<[^>]+>/g, " ");
    t = t.replace(/[^\p{L}\p{N}\s]/gu, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
  },

  /**
   * Check if two titles match using normalized equality or significant token overlap.
   */
  titlesMatch(titleA, titleB) {
    const normA = this.normalizeTitle(titleA);
    const normB = this.normalizeTitle(titleB);
    if (!normA || !normB) return false;
    if (normA === normB) return true;

    // Token set overlap (Jaccard >= 0.8 or Dice >= 0.85)
    const tokensA = new Set(normA.split(" ").filter(w => w.length > 2));
    const tokensB = new Set(normB.split(" ").filter(w => w.length > 2));
    if (tokensA.size === 0 || tokensB.size === 0) return normA === normB;

    let intersection = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) intersection++;
    }
    const union = new Set([...tokensA, ...tokensB]).size;
    const jaccard = union > 0 ? intersection / union : 0;
    const dice = (tokensA.size + tokensB.size > 0) ? (2 * intersection) / (tokensA.size + tokensB.size) : 0;

    return jaccard >= 0.8 || dice >= 0.85;
  },

  /**
   * Extract a 4-digit publication year from a string or number.
   */
  extractYear(dateVal) {
    if (dateVal === null || dateVal === undefined) return null;
    const match = String(dateVal).match(/\b(1[7-9]\d\d|20\d\d)\b/);
    return match ? match[1] : null;
  },

  /**
   * Extract normalized lowercase author tokens / family names.
   */
  extractAuthorTokens(authors) {
    if (!authors) return [];
    let authorList = [];
    if (Array.isArray(authors)) {
      authorList = authors;
    } else if (typeof authors === "string") {
      authorList = authors.split(/[,;&]|\band\b/i);
    }
    const tokens = [];
    for (const a of authorList) {
      if (typeof a !== "string") continue;
      const parts = a.replace(/[^\p{L}\s]/gu, " ").trim().toLowerCase().split(/\s+/);
      for (const p of parts) {
        if (p.length > 2) {
          tokens.push(p);
        }
      }
    }
    return tokens;
  },

  /**
   * Check if author metadata overlaps between two records.
   * Returns matching token if found, false if both have author info but no overlap,
   * or null if author info is unavailable on either record.
   */
  authorsMatch(authorsA, authorsB) {
    const tokensA = this.extractAuthorTokens(authorsA);
    const tokensB = this.extractAuthorTokens(authorsB);
    if (tokensA.length === 0 || tokensB.length === 0) return null;
    for (const t of tokensA) {
      if (tokensB.includes(t)) {
        return t;
      }
    }
    return false;
  },

  /**
   * Retrieve items from the local Zotero library (strictly read-only).
   * Supports injecting mockLibraryItems for testing.
   */
  async getLocalLibraryItems(libraryID) {
    if (this.mockLibraryItemsByLibraryID && libraryID && this.mockLibraryItemsByLibraryID[libraryID]) {
      return this.mockLibraryItemsByLibraryID[libraryID];
    }
    if (Array.isArray(this.mockLibraryItems)) {
      return this.mockLibraryItems;
    }

    try {
      if (typeof Zotero === "undefined" || !Zotero.Items || typeof Zotero.Items.getAll !== "function") {
        return [];
      }

      let targetLibraryID = libraryID;
      if (!targetLibraryID) {
        if (Zotero.getActiveZoteroPane && typeof Zotero.getActiveZoteroPane === "function") {
          try {
            targetLibraryID = Zotero.getActiveZoteroPane()?.getSelectedLibraryID();
          } catch (e) {}
        }
        if (!targetLibraryID && Zotero.Libraries) {
          targetLibraryID = Zotero.Libraries.userLibraryID;
        }
        if (!targetLibraryID) {
          targetLibraryID = 1;
        }
      }

      const rawItems = await Zotero.Items.getAll(targetLibraryID, true, false);
      if (!Array.isArray(rawItems)) return [];

      const regularItems = rawItems.filter(item => {
        if (!item) return false;
        if (typeof item.isRegularItem === "function") {
          return item.isRegularItem();
        }
        const isNote = typeof item.isNote === "function" ? item.isNote() : false;
        const isAttachment = typeof item.isAttachment === "function" ? item.isAttachment() : false;
        return !isNote && !isAttachment;
      });

      return regularItems.map(item => {
        let title = "";
        try {
          if (typeof item.getField === "function") {
            title = item.getField("title") || "";
          }
        } catch (e) {}
        if (!title) title = item.title || "";

        let doi = "";
        try {
          if (typeof item.getField === "function") {
            doi = item.getField("DOI") || "";
          }
        } catch (e) {}
        if (!doi) doi = item.DOI || item.doi || "";

        let dateVal = "";
        try {
          if (typeof item.getField === "function") {
            dateVal = item.getField("date") || "";
          }
        } catch (e) {}
        if (!dateVal) dateVal = item.date || item.year || "";
        let authors = [];
        if (typeof item.getCreators === "function") {
          const creators = item.getCreators() || [];
          for (const c of creators) {
            const name = c.lastName || c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim();
            if (name) authors.push(name);
          }
        } else if (Array.isArray(item.creators)) {
          authors = item.creators.map(c => c.lastName || c.name || String(c)).filter(Boolean);
        } else if (item.author) {
          authors = [item.author];
        }

        return {
          id: item.id || null,
          key: item.key || null,
          title: title || "",
          doi: doi || null,
          date: dateVal || "",
          year: this.extractYear(dateVal),
          authors,
          author: authors.join(", "),
          rawItem: item
        };
      });
    } catch (err) {
      this.logError(err);
      return [];
    }
  },

  /**
   * Perform duplicate detection against local Zotero library items.
   *
   * Logic hierarchy:
   * 1. Strongest match: Normalized DOI match -> "Already in Zotero"
   * 2. Secondary match: When DOI is missing on one/both, normalized title + matching year
   *    and author metadata -> "Possible Duplicate"
   * 3. No match or title-only similarity without matching year/author -> "New"
   */
  detectDuplicates(orcidWorks, localLibraryItems = []) {
    if (!Array.isArray(orcidWorks)) return [];
    const items = Array.isArray(localLibraryItems) ? localLibraryItems : [];

    // Map normalized DOIs from local library for O(1) lookup
    const localDoiMap = new Map();
    for (const item of items) {
      const normDoi = this.normalizeDoi(item.doi);
      if (normDoi) {
        localDoiMap.set(normDoi, item);
      }
    }

    return orcidWorks.map(work => {
      const workDoi = this.normalizeDoi(work.doi);
      const workYear = this.extractYear(work.year);

      // 1. Check normalized DOI (strongest match)
      if (workDoi && localDoiMap.has(workDoi)) {
        const matched = localDoiMap.get(workDoi);
        return {
          ...work,
          duplicateStatus: "Already in Zotero",
          matchType: "DOI",
          matchReason: `Matched DOI: ${workDoi}`,
          matchedItem: {
            id: matched.id,
            key: matched.key,
            title: matched.title,
            doi: matched.doi,
            year: matched.year,
            author: matched.author
          }
        };
      }

      // 2. Check title + year + author against local items
      for (const item of items) {
        if (this.titlesMatch(work.title, item.title)) {
          const itemYear = this.extractYear(item.year || item.date);
          const authorMatch = this.authorsMatch(
            work.authors || work.author,
            item.authors || item.author
          );

          // Case A: Both have year and years match
          if (workYear && itemYear && workYear === itemYear) {
            // If both have author info and they conflict, don't mark as duplicate
            if (authorMatch === false) {
              continue;
            }
            const authorDetail = typeof authorMatch === "string"
              ? ` and author (${authorMatch})`
              : "";
            return {
              ...work,
              duplicateStatus: "Possible Duplicate",
              matchType: "TITLE_YEAR",
              matchReason: `Title and year (${workYear})${authorDetail} match local item`,
              matchedItem: {
                id: item.id,
                key: item.key,
                title: item.title,
                doi: item.doi,
                year: itemYear,
                author: item.author
              }
            };
          }

          // Case B: Year is missing on one or both, but author matches
          if ((!workYear || !itemYear) && typeof authorMatch === "string") {
            return {
              ...work,
              duplicateStatus: "Possible Duplicate",
              matchType: "TITLE_AUTHOR",
              matchReason: `Title and author (${authorMatch}) match local item (year unavailable)`,
              matchedItem: {
                id: item.id,
                key: item.key,
                title: item.title,
                doi: item.doi,
                year: itemYear,
                author: item.author
              }
            };
          }

          // Case C: Title matches, but years differ or both year & author are missing:
          // Rule: "Do not treat title-only similarity as a confirmed duplicate."
          // Remains candidate for New unless another item matches.
        }
      }

      // 3. No match found in local library
      return {
        ...work,
        duplicateStatus: "New",
        matchType: null,
        matchReason: "No match found in local Zotero library",
        matchedItem: null
      };
    });
  },

  /**
   * Compute duplicate summary statistics.
   */
  computeDuplicateStats(works = []) {
    let alreadyCount = 0;
    let possibleCount = 0;
    let newCount = 0;
    for (const w of works) {
      if (w.duplicateStatus === "Already in Zotero") {
        alreadyCount++;
      } else if (w.duplicateStatus === "Possible Duplicate") {
        possibleCount++;
      } else {
        newCount++;
      }
    }
    return { alreadyCount, possibleCount, newCount };
  },

  /**
   * Format fetched works into a clean, read-only preview text.
   * Displays title, author, year, DOI, type, and duplicate detection status.
   */
  formatWorksPreview(data) {
    const payload = data?.data || data || {};
    const orcid = payload.orcid || data?.orcid || "N/A";
    const total = payload.totalWorks ?? data?.totalWorks ?? (payload.works?.length || 0);
    const works = Array.isArray(payload.works) ? payload.works : (Array.isArray(data?.works) ? data.works : []);
    const stats = payload.duplicateStats || data?.duplicateStats || this.computeDuplicateStats(works);

    let lines = [];
    lines.push("==================================================");
    lines.push("           ORCID PUBLIC WORKS PREVIEW            ");
    lines.push("==================================================");
    lines.push(`ORCID iD:    ${orcid}`);
    lines.push(`Total Works: ${total}`);
    if (works.length > 0) {
      lines.push(`Detection:   ${stats.alreadyCount} Already in Zotero | ${stats.possibleCount} Possible Duplicate | ${stats.newCount} New`);
    }
    lines.push("--------------------------------------------------");

    if (works.length === 0) {
      lines.push("No public works found for this ORCID profile.");
    } else {
      const previewLimit = Math.min(works.length, 10);
      for (let i = 0; i < previewLimit; i++) {
        const w = works[i];
        const statusLabel = w.duplicateStatus || "New";
        const authorsText = w.author || (Array.isArray(w.authors) && w.authors.length > 0 ? w.authors.join(", ") : "Not specified");

        lines.push(`[${i + 1}] [${statusLabel}]`);
        lines.push(`    Title:   ${w.title || "(Untitled)"}`);
        lines.push(`    Authors: ${authorsText}`);
        lines.push(`    Year:    ${w.year || "Not specified"}`);
        lines.push(`    DOI:     ${w.doi || "None"}`);
        lines.push(`    Type:    ${w.type || "work"}`);
        if (w.journalTitle) {
          lines.push(`    Journal: ${w.journalTitle}`);
        }
        if (w.isEnriched || (w.sources && w.sources.includes("crossref"))) {
          lines.push(`    Source:  ORCID + Crossref`);
        }
        if (w.matchReason && statusLabel !== "New") {
          lines.push(`    Match:   ${w.matchReason}`);
        }
        lines.push("");
      }
      if (works.length > previewLimit) {
        lines.push(`... and ${works.length - previewLimit} more public works (total: ${total}).`);
      }
    }

    lines.push("==================================================");
    lines.push("READ-ONLY PREVIEW: No items were imported, created,");
    lines.push("modified, edited, deleted, or pushed in your Zotero library.");
    lines.push("==================================================");

    return lines.join("\n");
  },

  /**
   * Interactive UI flow: prompt for ORCID iD, query helper, detect duplicates, and display preview.
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

      // Perform duplicate detection against local Zotero library (read-only)
      const localItems = await this.getLocalLibraryItems();
      const rawWorks = Array.isArray(result.works)
        ? result.works
        : (Array.isArray(result.data?.works) ? result.data.works : []);
      const annotatedWorks = this.detectDuplicates(rawWorks, localItems);
      const duplicateStats = this.computeDuplicateStats(annotatedWorks);

      result.works = annotatedWorks;
      result.duplicateStats = duplicateStats;

      // Step 4: Show the interactive selection and import UI
      if (window && window.document && typeof window.document.createElement === "function" && (window.document.body || window.document.documentElement)) {
        this.showImportModal(window, result);
        return;
      } else {
        await this.promptImportSelectionFallback(window, result);
        return;
      }
    }
  },

  /**
   * Discover available destination libraries (User Library & Group Libraries) and their collections.
   */
  getAvailableDestinations() {
    const result = {
      libraries: [],
      defaultLibraryID: 1,
      defaultCollectionID: null
    };

    let activePaneLibID = null;
    let activePaneColID = null;

    if (typeof Zotero !== "undefined") {
      if (Zotero.getActiveZoteroPane && typeof Zotero.getActiveZoteroPane === "function") {
        try {
          const pane = Zotero.getActiveZoteroPane();
          if (pane) {
            if (typeof pane.getSelectedLibraryID === "function") {
              activePaneLibID = pane.getSelectedLibraryID();
            }
            if (typeof pane.getSelectedCollection === "function") {
              const col = pane.getSelectedCollection();
              if (col) activePaneColID = col.id;
            }
          }
        } catch (e) {}
      }

      const userLibID = (Zotero.Libraries && Zotero.Libraries.userLibraryID) ? Zotero.Libraries.userLibraryID : 1;
      result.defaultLibraryID = activePaneLibID || userLibID;
      result.defaultCollectionID = activePaneColID;

      if (Zotero.Libraries && typeof Zotero.Libraries.getAll === "function") {
        try {
          const allLibs = Zotero.Libraries.getAll();
          for (const lib of allLibs) {
            const libID = lib.libraryID !== undefined ? lib.libraryID : lib.id;
            const isUser = libID === userLibID || lib.libraryType === "user" || lib.isUser;
            const isGroup = !isUser && (lib.libraryType === "group" || lib.isGroup || true);
            let libName = lib.name;
            if (!libName) {
              libName = isUser ? "My Library" : `Group Library (${libID})`;
            }

            // Fetch collections for this library
            let collections = [];
            if (Zotero.Collections && typeof Zotero.Collections.getByLibrary === "function") {
              try {
                const cols = Zotero.Collections.getByLibrary(libID);
                if (Array.isArray(cols)) {
                  collections = cols.map(c => ({
                    id: c.id,
                    name: c.name || `Collection ${c.id}`,
                    parentID: c.parentID || null
                  }));
                }
              } catch (colErr) {}
            }

            result.libraries.push({
              id: libID,
              name: libName,
              isGroup,
              isUser,
              collections
            });
          }
        } catch (libErr) {
          this.logError(libErr);
        }
      }
    }

    // Fallback if no libraries were populated (e.g. mock or test environment)
    if (result.libraries.length === 0) {
      result.libraries.push({
        id: 1,
        name: "My Library",
        isGroup: false,
        isUser: true,
        collections: []
      });
    }

    return result;
  },

  /**
   * Resolve target library ID (user's selected or primary library).
   */
  getTargetLibraryID(libraryID) {
    if (libraryID) return libraryID;
    if (typeof Zotero !== "undefined") {
      if (Zotero.getActiveZoteroPane && typeof Zotero.getActiveZoteroPane === "function") {
        try {
          const paneLibID = Zotero.getActiveZoteroPane()?.getSelectedLibraryID();
          if (paneLibID) return paneLibID;
        } catch (e) {}
      }
      if (Zotero.Libraries && Zotero.Libraries.userLibraryID) {
        return Zotero.Libraries.userLibraryID;
      }
    }
    return 1;
  },

  /**
   * Resolve target library human-readable name.
   */
  getTargetLibraryName(libraryID) {
    if (typeof Zotero !== "undefined" && Zotero.Libraries && typeof Zotero.Libraries.getName === "function") {
      try {
        const name = Zotero.Libraries.getName(libraryID);
        if (name) return name;
      } catch (e) {}
    }
    const destinations = this.getAvailableDestinations();
    const found = destinations.libraries.find(l => l.id === libraryID || String(l.id) === String(libraryID));
    if (found && found.name) return found.name;
    return libraryID === 1 ? "My Library" : `Library ${libraryID}`;
  },

  /**
   * Resolve target collection human-readable name.
   */
  getTargetCollectionName(libraryID, collectionID) {
    if (!collectionID) return null;
    if (typeof Zotero !== "undefined" && Zotero.Collections) {
      try {
        if (typeof Zotero.Collections.get === "function") {
          const col = Zotero.Collections.get(collectionID);
          if (col && col.name) return col.name;
        }
        if (typeof Zotero.Collections.getByLibrary === "function") {
          const cols = Zotero.Collections.getByLibrary(libraryID);
          const found = cols.find(c => c.id === collectionID || String(c.id) === String(collectionID));
          if (found && found.name) return found.name;
        }
      } catch (e) {}
    }
    const destinations = this.getAvailableDestinations();
    const lib = destinations.libraries.find(l => l.id === libraryID || String(l.id) === String(libraryID));
    if (lib && Array.isArray(lib.collections)) {
      const col = lib.collections.find(c => c.id === collectionID || String(c.id) === String(collectionID));
      if (col && col.name) return col.name;
    }
    return `Collection ${collectionID}`;
  },

  /**
   * Map ORCID work types to official Zotero item types.
   */
  mapOrcidTypeToZotero(orcidType) {
    if (!orcidType || typeof orcidType !== "string") return "journalArticle";
    const t = orcidType.toLowerCase().replace(/_/g, "-");
    switch (t) {
      case "journal-article":
      case "journal-issue":
        return "journalArticle";
      case "book":
      case "edited-book":
        return "book";
      case "book-chapter":
      case "book-section":
        return "bookSection";
      case "conference-paper":
      case "conference-abstract":
      case "proceedings-article":
        return "conferencePaper";
      case "report":
        return "report";
      case "dissertation":
      case "dissertation-thesis":
        return "thesis";
      case "patent":
        return "patent";
      case "preprint":
        return "preprint";
      case "magazine-article":
        return "magazineArticle";
      case "newspaper-article":
        return "newspaperArticle";
      case "data-set":
        return "dataset";
      case "working-paper":
      case "manuscript":
        return "manuscript";
      default:
        return "journalArticle";
    }
  },

  /**
   * Normalize an author entry from string or structured object into a Zotero creator object.
   * Preserves organizational authors with fieldMode=1.
   */
  normalizeCreator(authorInput) {
    if (!authorInput) return { lastName: "Unknown", creatorType: "author" };

    // 1. Structured object (e.g. from Crossref or ORCID detail)
    if (typeof authorInput === "object") {
      const creatorType = authorInput.creatorType || "author";

      // Institutional or collaboration author
      if (authorInput.fieldMode === 1 || authorInput.name) {
        const orgName = (authorInput.name || authorInput.lastName || authorInput.fullName || "").trim();
        return {
          firstName: "",
          lastName: orgName || "Unknown Organization",
          fieldMode: 1,
          creatorType
        };
      }

      const lastName = (authorInput.lastName || authorInput.family || "").trim();
      const firstName = (authorInput.firstName || authorInput.given || "").trim();

      if (!firstName && !lastName) {
        if (authorInput.fullName) {
          return this.parseAuthorName(authorInput.fullName);
        }
        return { lastName: "Unknown", creatorType };
      }

      if (!firstName) {
        return this.parseAuthorName(lastName);
      }

      return {
        firstName,
        lastName: lastName || "Unknown",
        creatorType
      };
    }

    // 2. String representation
    if (typeof authorInput === "string") {
      return this.parseAuthorName(authorInput);
    }

    return { lastName: "Unknown", creatorType: "author" };
  },

  /**
   * Parse a raw author string into Zotero creator object.
   */
  parseAuthorName(rawName) {
    if (typeof rawName !== "string" || !rawName.trim()) {
      return { lastName: "Unknown", creatorType: "author" };
    }
    const trimmed = rawName.trim();
    if (trimmed.includes(",")) {
      const parts = trimmed.split(",").map(p => p.trim());
      return {
        lastName: parts[0] || "",
        firstName: parts.slice(1).join(" ") || "",
        creatorType: "author"
      };
    }
    // Check for single institution or organizational team/collaboration name
    const orgPattern = /\b(collaboration|consortium|group|team|committee|initiative|organization|organisation|university|institute|centre|center|department|laboratory|lab|agency|commission|foundation)\b/i;
    const spaceParts = trimmed.split(/\s+/);
    if (spaceParts.length === 1 || orgPattern.test(trimmed)) {
      return {
        firstName: "",
        lastName: trimmed,
        fieldMode: 1,
        creatorType: "author"
      };
    }
    const lastName = spaceParts.pop();
    const firstName = spaceParts.join(" ");
    return {
      firstName,
      lastName,
      creatorType: "author"
    };
  },

  /**
   * Safely set a Zotero item field if supported and non-empty.
   */
  setItemFieldSafe(item, field, value) {
    if (!item || !field || value === undefined || value === null) return false;
    const strVal = String(value).trim();
    if (!strVal) return false;

    try {
      if (typeof Zotero !== "undefined" && Zotero.ItemFields && typeof Zotero.ItemFields.isValidForType === "function" && item.itemTypeID) {
        const fieldID = (typeof Zotero.ItemFields.getID === "function") ? Zotero.ItemFields.getID(field) : null;
        if (fieldID && !Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) {
          return false;
        }
      }
      if (typeof item.isValidField === "function") {
        if (!item.isValidField(field)) return false;
      }
      item.setField(field, strVal);
      return true;
    } catch (e) {
      return false;
    }
  },

  /**
   * Assess metadata quality, reporting available, enriched, and missing fields.
   */
  assessMetadataQuality(work) {
    const availableFields = [];
    const missingFields = [];
    const enrichedFields = Array.isArray(work.enrichedFields) ? work.enrichedFields : [];

    const checkField = (fieldKey, label) => {
      const val = work[fieldKey];
      const hasValue = (val !== undefined && val !== null && (
        typeof val === "string" ? val.trim().length > 0 :
        (Array.isArray(val) ? val.length > 0 : true)
      ));
      if (hasValue) {
        availableFields.push(label);
      } else {
        missingFields.push(label);
      }
    };

    checkField("title", "Title");
    checkField("authors", "Authors");
    checkField("date", "Date");
    checkField("doi", "DOI");
    checkField("journalTitle", "Journal/Source");
    checkField("volume", "Volume");
    checkField("issue", "Issue");
    checkField("pages", "Pages");
    checkField("issn", "ISSN");
    checkField("url", "URL");
    checkField("abstractNote", "Abstract");

    const rawSources = Array.isArray(work.sources) && work.sources.length > 0
      ? work.sources
      : (work.isEnriched ? ["orcid", "crossref"] : ["orcid"]);

    const isCrossrefEnriched = rawSources.includes("crossref");
    const sourceSummary = rawSources.length > 1 ? "ORCID + Crossref" : (rawSources[0] === "crossref" ? "Crossref" : "ORCID");

    return {
      availableFields,
      enrichedFields,
      missingFields,
      sources: rawSources,
      sourceSummary,
      isEnriched: isCrossrefEnriched,
      completenessScore: Math.round((availableFields.length / (availableFields.length + missingFields.length)) * 100)
    };
  },

  /**
   * Create and populate a Zotero.Item instance from enriched work metadata.
   */
  async createZoteroItem(work, targetLibraryID, targetCollectionID = null) {
    const zoteroType = this.mapOrcidTypeToZotero(work.type);
    const libID = this.getTargetLibraryID(targetLibraryID);

    let item;
    if (typeof Zotero !== "undefined" && typeof Zotero.Item === "function") {
      try {
        item = new Zotero.Item(zoteroType);
      } catch (e) {
        try {
          let typeID = (Zotero.ItemTypes && typeof Zotero.ItemTypes.getID === "function")
            ? Zotero.ItemTypes.getID(zoteroType)
            : null;
          item = new Zotero.Item(typeID || "journalArticle");
        } catch (e2) {
          item = new Zotero.Item("journalArticle");
        }
      }
    } else if (typeof Zotero !== "undefined" && Zotero.Items && typeof Zotero.Items.new === "function") {
      item = await Zotero.Items.new(zoteroType);
    } else {
      // Mock item for test environments
      item = {
        itemType: zoteroType,
        libraryID: libID,
        fields: {},
        creators: [],
        collections: [],
        setField(f, v) { this.fields[f] = v; },
        getField(f) { return this.fields[f]; },
        setCreators(c) { this.creators = c; },
        getCreators() { return this.creators; },
        addToCollection(cid) {
          if (!this.collections.includes(cid)) this.collections.push(cid);
        },
        setCollections(cids) { this.collections = Array.from(cids); },
        getCollections() { return this.collections; },
        async saveTx() { this.id = Math.floor(Math.random() * 100000) + 1; return this.id; }
      };
    }

    if (item && libID) {
      item.libraryID = libID;
    }

    if (item && targetCollectionID) {
      try {
        if (typeof item.addToCollection === "function") {
          item.addToCollection(targetCollectionID);
        } else if (typeof item.setCollections === "function") {
          item.setCollections([targetCollectionID]);
        }
      } catch (colErr) {
        this.logError(`Collection assignment note: ${colErr.message}`);
      }
    }

    // 1. Title (required)
    const title = (work.title || "").trim() || "(Untitled ORCID Publication)";
    this.setItemFieldSafe(item, "title", title);

    // 2. DOI (normalized)
    const normDoi = this.normalizeDoi(work.doi);
    if (normDoi) {
      this.setItemFieldSafe(item, "DOI", normDoi);
    }

    // 3. Publication Date / Year
    const effectiveDate = work.date || (work.year && work.year !== "Unknown" ? String(work.year) : null);
    if (effectiveDate) {
      this.setItemFieldSafe(item, "date", effectiveDate);
    }

    // 4. URL
    if (work.url) {
      this.setItemFieldSafe(item, "url", work.url);
    }

    // 5. Abstract
    if (work.abstractNote) {
      this.setItemFieldSafe(item, "abstractNote", work.abstractNote);
    }

    // 6. Language
    if (work.language) {
      this.setItemFieldSafe(item, "language", work.language);
    }

    // 7. Type-specific Bibliographic Field Mapping
    const containerTitle = work.journalTitle || work.containerTitle || null;

    switch (zoteroType) {
      case "journalArticle":
      case "magazineArticle":
      case "newspaperArticle":
        if (containerTitle) {
          this.setItemFieldSafe(item, "publicationTitle", containerTitle);
        }
        if (work.journalAbbreviation || work.shortContainerTitle) {
          this.setItemFieldSafe(item, "journalAbbreviation", work.journalAbbreviation || work.shortContainerTitle);
        }
        if (work.volume) {
          this.setItemFieldSafe(item, "volume", work.volume);
        }
        if (work.issue) {
          this.setItemFieldSafe(item, "issue", work.issue);
        }
        if (work.pages || work.page) {
          this.setItemFieldSafe(item, "pages", work.pages || work.page);
        }
        if (work.issn) {
          this.setItemFieldSafe(item, "ISSN", work.issn);
        }
        break;

      case "book":
        if (work.publisher) {
          this.setItemFieldSafe(item, "publisher", work.publisher);
        }
        if (work.isbn) {
          this.setItemFieldSafe(item, "ISBN", work.isbn);
        }
        if (work.volume) {
          this.setItemFieldSafe(item, "volume", work.volume);
        }
        if (work.pages) {
          this.setItemFieldSafe(item, "numPages", work.pages);
        }
        break;

      case "bookSection":
        if (containerTitle) {
          this.setItemFieldSafe(item, "bookTitle", containerTitle);
        }
        if (work.publisher) {
          this.setItemFieldSafe(item, "publisher", work.publisher);
        }
        if (work.volume) {
          this.setItemFieldSafe(item, "volume", work.volume);
        }
        if (work.pages || work.page) {
          this.setItemFieldSafe(item, "pages", work.pages || work.page);
        }
        if (work.isbn) {
          this.setItemFieldSafe(item, "ISBN", work.isbn);
        }
        break;

      case "conferencePaper":
        if (containerTitle) {
          this.setItemFieldSafe(item, "proceedingsTitle", containerTitle);
          this.setItemFieldSafe(item, "conferenceName", containerTitle);
        }
        if (work.publisher) {
          this.setItemFieldSafe(item, "publisher", work.publisher);
        }
        if (work.volume) {
          this.setItemFieldSafe(item, "volume", work.volume);
        }
        if (work.pages || work.page) {
          this.setItemFieldSafe(item, "pages", work.pages || work.page);
        }
        if (work.isbn) {
          this.setItemFieldSafe(item, "ISBN", work.isbn);
        }
        break;

      case "report":
        if (work.publisher || containerTitle) {
          this.setItemFieldSafe(item, "institution", work.publisher || containerTitle);
        }
        if (work.issue || work.volume) {
          this.setItemFieldSafe(item, "reportNumber", work.issue || work.volume);
        }
        if (work.pages || work.page) {
          this.setItemFieldSafe(item, "pages", work.pages || work.page);
        }
        break;

      case "thesis":
        if (work.publisher || containerTitle) {
          this.setItemFieldSafe(item, "university", work.publisher || containerTitle);
        }
        if (work.type) {
          this.setItemFieldSafe(item, "thesisType", work.type);
        }
        break;

      case "preprint":
        if (containerTitle || work.publisher) {
          this.setItemFieldSafe(item, "repository", containerTitle || work.publisher);
        }
        break;

      case "dataset":
        if (containerTitle || work.publisher) {
          this.setItemFieldSafe(item, "repository", containerTitle || work.publisher);
        }
        break;

      case "patent":
        if (work.issue || work.volume) {
          this.setItemFieldSafe(item, "patentNumber", work.issue || work.volume);
        }
        break;

      default:
        if (containerTitle) {
          this.setItemFieldSafe(item, "publicationTitle", containerTitle);
        }
        break;
    }

    // 8. Creators / Authors (supports both structured objects and strings)
    const rawAuthors = Array.isArray(work.authors) && work.authors.length > 0
      ? work.authors
      : (Array.isArray(work.contributors) && work.contributors.length > 0
        ? work.contributors
        : (work.author ? [work.author] : []));

    if (rawAuthors.length > 0) {
      const creators = [];
      for (const a of rawAuthors) {
        if (!a) continue;
        creators.push(this.normalizeCreator(a));
      }
      if (creators.length > 0) {
        try {
          item.setCreators(creators);
        } catch (e) {
          this.logError(e);
        }
      }
    }

    // 9. Extra Provenance (Strictly ORCID & Source provenance only)
    const extraLines = [];
    if (work.orcid) {
      extraLines.push(`ORCID: ${work.orcid}`);
    }
    if (work.putCode) {
      extraLines.push(`ORCID-Put-Code: ${work.putCode}`);
    }
    const sources = Array.isArray(work.sources) && work.sources.length > 0
      ? work.sources
      : (work.isEnriched ? ["orcid", "crossref"] : ["orcid"]);
    extraLines.push(`Sources: ${sources.map(s => s.toUpperCase()).join(", ")}`);

    try {
      const existingExtra = (typeof item.getField === "function") ? (item.getField("extra") || "") : "";
      const combined = existingExtra ? `${existingExtra}\n${extraLines.join("\n")}` : extraLines.join("\n");
      item.setField("extra", combined);
    } catch (e) {}

    return item;
  },

  /**
   * Import selected publications into the local Zotero library.
   * Supports targetLibraryID (personal or group library) and optional targetCollectionID.
   * Rechecks for duplicates immediately before saving to prevent duplicate imports.
   */
  async importPublications(selectedWorks, targetLibraryID, targetCollectionID = null) {
    if (!Array.isArray(selectedWorks) || selectedWorks.length === 0) {
      return { success: true, imported: 0, skipped: 0, failed: 0, errors: [], importedItems: [] };
    }

    const libID = this.getTargetLibraryID(targetLibraryID);

    // 1. Recheck duplicates against current library state immediately before saving
    const currentLibraryItems = await this.getLocalLibraryItems(libID);
    const recheckedWorks = this.detectDuplicates(selectedWorks, currentLibraryItems);

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];
    const importedItems = [];

    // Working copy of library items to prevent intra-batch duplicate creation
    const workingLibraryItems = [...currentLibraryItems];

    for (const work of recheckedWorks) {
      // Recheck against current working library items (intra-batch duplicate prevention)
      const currentCheck = this.detectDuplicates([work], workingLibraryItems);
      if (currentCheck[0].duplicateStatus === "Already in Zotero") {
        this.log(`Skipping duplicate publication: "${work.title}" (DOI: ${work.doi || "None"})`);
        skipped++;
        continue;
      }

      try {
        const item = await this.createZoteroItem(work, libID, targetCollectionID);
        // Supported Zotero save mechanism
        if (typeof item.saveTx === "function") {
          await item.saveTx();
        } else if (typeof item.save === "function") {
          await item.save();
        }

        imported++;
        importedItems.push(item);
        this.log(`Successfully created Zotero item for: "${work.title}" (ID: ${item.id}) in library ${libID}${targetCollectionID ? ' collection ' + targetCollectionID : ''}`);

        // Add newly imported item to working items for subsequent intra-batch checks
        workingLibraryItems.push({
          id: item.id,
          title: work.title,
          doi: work.doi,
          year: work.year,
          author: work.author,
          authors: work.authors
        });
      } catch (err) {
        failed++;
        errors.push({ title: work.title, error: err.message });
        this.logError(`Failed to save Zotero item for "${work.title}": ${err.message}`);
      }
    }

    return {
      success: failed === 0,
      imported,
      skipped,
      failed,
      errors,
      importedItems
    };
  },

  /**
   * Confirm import of possible duplicate publications.
   */
  confirmPossibleDuplicates(window, possibleDups) {
    const promptService = (typeof Services !== "undefined" && Services.prompt) ? Services.prompt : null;
    if (!promptService || typeof promptService.confirm !== "function") return true;

    const dupList = possibleDups.slice(0, 5).map(d => `• "${d.title}" (${d.year || "N/A"}) - ${d.matchReason || "Matches local item"}`).join("\n");
    const moreNote = possibleDups.length > 5 ? `\n... and ${possibleDups.length - 5} more.` : "";

    return promptService.confirm(
      window || null,
      "ORCID Assistant - Confirm Import of Possible Duplicates",
      `CAUTION: You have selected ${possibleDups.length} record(s) flagged as Possible Duplicate:\n\n${dupList}${moreNote}\n\nImporting these records may create duplicate items in your Zotero library.\n\nDo you want to proceed with importing them?`
    );
  },

  /**
   * Final confirmation prompt before executing import.
   */
  confirmImport(window, selectedWorks, targetLibraryID, targetCollectionID = null) {
    const promptService = (typeof Services !== "undefined" && Services.prompt) ? Services.prompt : null;
    if (!promptService || typeof promptService.confirm !== "function") return true;

    const libID = this.getTargetLibraryID(targetLibraryID);
    const libraryName = this.getTargetLibraryName(libID);
    const collectionName = targetCollectionID ? this.getTargetCollectionName(libID, targetCollectionID) : null;
    const newCount = selectedWorks.filter(w => w.duplicateStatus === "New").length;
    const possibleCount = selectedWorks.filter(w => w.duplicateStatus === "Possible Duplicate").length;
    const alreadyCount = selectedWorks.filter(w => w.duplicateStatus === "Already in Zotero").length;

    let destText = `Destination: ${libraryName}`;
    if (collectionName) {
      destText += ` > ${collectionName}`;
    }

    let breakdown = `• New records: ${newCount}`;
    if (possibleCount > 0) breakdown += `\n• Possible duplicates: ${possibleCount}`;
    if (alreadyCount > 0) breakdown += `\n• Already in library: ${alreadyCount}`;

    return promptService.confirm(
      window || null,
      "ORCID Assistant - Confirm Import",
      `You are about to import ${selectedWorks.length} publication(s) into your local Zotero library.\n\n${destText}\n${breakdown}\n\nDo you want to proceed?`
    );
  },

  /**
   * Interactive modal dialog with checkboxes, controls, and import actions.
   */
  showImportModal(window, result) {
    const doc = window.document;
    if (!doc) return;

    // Clean up existing modal if already open
    const existingOverlay = doc.getElementById("orcid-assistant-modal-overlay");
    if (existingOverlay) {
      existingOverlay.remove();
    }

    const works = Array.isArray(result.works) ? result.works : [];
    const orcid = result.orcid || "N/A";
    const totalCount = works.length;

    // Initialize selection state: New works selected by default, others unselected
    works.forEach(w => {
      if (w.selected === undefined) {
        w.selected = (w.duplicateStatus === "New");
      }
    });

    const overlay = doc.createElement("div");
    overlay.id = "orcid-assistant-modal-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;background-color:rgba(0,0,0,0.5);display:flex;justify-content:center;align-items:center;z-index:999999;font-family:system-ui,-apple-system,sans-serif;box-sizing:border-box;";

    const modal = doc.createElement("div");
    modal.id = "orcid-assistant-modal";
    modal.style.cssText = "width:780px;max-width:92vw;max-height:88vh;background:#ffffff;color:#1e293b;border-radius:10px;box-shadow:0 20px 25px -5px rgba(0,0,0,0.25);display:flex;flex-direction:column;overflow:hidden;border:1px solid #cbd5e1;";

    // Header
    const header = doc.createElement("div");
    header.style.cssText = "padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;background:#f8fafc;";

    const headerTextContainer = doc.createElement("div");
    const headerTitle = doc.createElement("h3");
    headerTitle.style.cssText = "margin:0;font-size:1.15rem;font-weight:700;color:#0f172a;";
    headerTitle.textContent = "ORCID Assistant — Public Works Import";

    const headerSub = doc.createElement("p");
    headerSub.style.cssText = "margin:4px 0 0 0;font-size:0.85rem;color:#64748b;";
    headerSub.textContent = `ORCID iD: ${orcid} • ${totalCount} Public Works Found`;

    headerTextContainer.appendChild(headerTitle);
    headerTextContainer.appendChild(headerSub);
    header.appendChild(headerTextContainer);

    const headerRight = doc.createElement("div");
    headerRight.style.cssText = "display:flex;align-items:center;gap:10px;";

    const batchBtn = doc.createElement("button");
    batchBtn.textContent = "📁 Batch CSV Import...";
    batchBtn.style.cssText = "padding:5px 12px;font-size:0.8rem;background:#ffffff;border:1px solid #cbd5e1;border-radius:5px;cursor:pointer;color:#334155;font-weight:500;";
    batchBtn.addEventListener("click", () => {
      overlay.remove();
      this.showBatchImportModal(window);
    });
    headerRight.appendChild(batchBtn);

    const closeBtn = doc.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = "background:transparent;border:none;font-size:1.5rem;cursor:pointer;color:#64748b;line-height:1;padding:4px 8px;border-radius:4px;";
    closeBtn.addEventListener("click", () => overlay.remove());
    headerRight.appendChild(closeBtn);

    header.appendChild(headerRight);
    modal.appendChild(header);

    // Destination Selection Bar (User Library / Group Libraries & Collections)
    const destBar = doc.createElement("div");
    destBar.id = "orcid-dest-bar";
    destBar.style.cssText = "padding:10px 20px;background:#f8fafc;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;flex-wrap:wrap;gap:12px;";

    const destLabel = doc.createElement("span");
    destLabel.style.cssText = "font-size:0.83rem;font-weight:600;color:#334155;";
    destLabel.textContent = "Destination Library / Group:";
    destBar.appendChild(destLabel);

    const libSelect = doc.createElement("select");
    libSelect.id = "orcid-library-select";
    libSelect.style.cssText = "padding:4px 8px;font-size:0.82rem;border:1px solid #cbd5e1;border-radius:4px;background:#ffffff;color:#1e293b;max-width:240px;";

    const destinations = this.getAvailableDestinations();
    let currentSelectedLibID = destinations.defaultLibraryID || 1;
    let currentSelectedColID = destinations.defaultCollectionID || null;

    destinations.libraries.forEach(lib => {
      const opt = doc.createElement("option");
      opt.value = String(lib.id);
      opt.textContent = lib.isGroup ? `[Group] ${lib.name}` : lib.name;
      if (lib.id === currentSelectedLibID || String(lib.id) === String(currentSelectedLibID)) {
        opt.selected = true;
      }
      libSelect.appendChild(opt);
    });
    destBar.appendChild(libSelect);

    const colLabel = doc.createElement("span");
    colLabel.style.cssText = "font-size:0.83rem;font-weight:600;color:#334155;margin-left:4px;";
    colLabel.textContent = "Collection:";
    destBar.appendChild(colLabel);

    const colSelect = doc.createElement("select");
    colSelect.id = "orcid-collection-select";
    colSelect.style.cssText = "padding:4px 8px;font-size:0.82rem;border:1px solid #cbd5e1;border-radius:4px;background:#ffffff;color:#1e293b;max-width:200px;";

    const populateCollections = (libID) => {
      while (colSelect.firstChild) {
        colSelect.removeChild(colSelect.firstChild);
      }
      const rootOpt = doc.createElement("option");
      rootOpt.value = "";
      rootOpt.textContent = "(Entire Library / Root)";
      colSelect.appendChild(rootOpt);

      const targetLib = destinations.libraries.find(l => l.id === libID || String(l.id) === String(libID));
      if (targetLib && Array.isArray(targetLib.collections)) {
        targetLib.collections.forEach(c => {
          const opt = doc.createElement("option");
          opt.value = String(c.id);
          opt.textContent = c.name;
          if (c.id === currentSelectedColID || String(c.id) === String(currentSelectedColID)) {
            opt.selected = true;
          }
          colSelect.appendChild(opt);
        });
      }
    };

    populateCollections(currentSelectedLibID);
    destBar.appendChild(colSelect);
    modal.appendChild(destBar);

    // Toolbar / Stats Bar
    const stats = result.duplicateStats || this.computeDuplicateStats(works);
    const toolbar = doc.createElement("div");
    toolbar.style.cssText = "padding:12px 20px;background:#f1f5f9;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;";

    const badgesContainer = doc.createElement("div");
    badgesContainer.style.cssText = "display:flex;gap:6px;align-items:center;";

    const makeBadge = (text, bg, color) => {
      const b = doc.createElement("span");
      b.style.cssText = `font-size:0.75rem;font-weight:600;padding:3px 8px;border-radius:9999px;background:${bg};color:${color};`;
      b.textContent = text;
      return b;
    };

    const badgeAlready = makeBadge(`Already in Zotero: ${stats.alreadyCount}`, "#e2e8f0", "#475569");
    const badgePossible = makeBadge(`Possible Duplicate: ${stats.possibleCount}`, "#fef3c7", "#92400e");
    const badgeNew = makeBadge(`New: ${stats.newCount}`, "#dcfce7", "#166534");

    badgesContainer.appendChild(badgeAlready);
    badgesContainer.appendChild(badgePossible);
    badgesContainer.appendChild(badgeNew);

    const actionsContainer = doc.createElement("div");
    actionsContainer.style.cssText = "display:flex;gap:8px;align-items:center;";

    const selectionSummary = doc.createElement("span");
    selectionSummary.id = "orcid-selection-summary";
    selectionSummary.style.cssText = "font-size:0.82rem;font-weight:600;color:#334155;margin-right:4px;";

    const btnSelectNew = doc.createElement("button");
    btnSelectNew.textContent = "Select New";
    btnSelectNew.style.cssText = "padding:5px 10px;font-size:0.8rem;font-weight:500;background:#ffffff;border:1px solid #cbd5e1;border-radius:5px;cursor:pointer;color:#334155;";

    const btnClearSelection = doc.createElement("button");
    btnClearSelection.textContent = "Clear Selection";
    btnClearSelection.style.cssText = "padding:5px 10px;font-size:0.8rem;font-weight:500;background:#ffffff;border:1px solid #cbd5e1;border-radius:5px;cursor:pointer;color:#334155;";

    actionsContainer.appendChild(selectionSummary);
    actionsContainer.appendChild(btnSelectNew);
    actionsContainer.appendChild(btnClearSelection);

    toolbar.appendChild(badgesContainer);
    toolbar.appendChild(actionsContainer);
    modal.appendChild(toolbar);

    // Warning banner for selected possible duplicates
    const warningBanner = doc.createElement("div");
    warningBanner.id = "orcid-warning-banner";
    warningBanner.style.cssText = "background:#fffbeb;border-bottom:1px solid #fde68a;color:#92400e;padding:8px 20px;font-size:0.82rem;display:none;";
    modal.appendChild(warningBanner);

    // Scrollable Body
    const body = doc.createElement("div");
    body.style.cssText = "padding:16px 20px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:12px;";

    const checkboxes = [];
    const cardUpdaters = [];

    works.forEach((w, idx) => {
      const card = doc.createElement("div");
      card.className = "orcid-work-card";
      card.style.cssText = "border:1px solid #e2e8f0;border-radius:6px;padding:12px;display:flex;gap:12px;background:#ffffff;";

      const cbCol = doc.createElement("div");
      cbCol.style.cssText = "padding-top:2px;";

      const cb = doc.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!w.selected;
      cb.style.cssText = "width:17px;height:17px;cursor:pointer;";
      cb.addEventListener("change", (e) => {
        w.selected = e.target.checked;
        updateUI();
      });
      checkboxes.push(cb);
      cbCol.appendChild(cb);

      const contentCol = doc.createElement("div");
      contentCol.style.cssText = "flex:1;min-width:0;";

      // Status pill styling
      let pillBg = "#dcfce7";
      let pillColor = "#166534";
      if (w.duplicateStatus === "Already in Zotero") {
        pillBg = "#e2e8f0";
        pillColor = "#475569";
      } else if (w.duplicateStatus === "Possible Duplicate") {
        pillBg = "#fef3c7";
        pillColor = "#92400e";
      }

      const authorsText = Array.isArray(w.authors) && w.authors.length > 0
        ? w.authors.map(a => typeof a === "object" ? (a.fullName || a.lastName) : a).join(", ")
        : (w.author || "Not specified");

      // Source and enrichment indicator
      const quality = w.metadataQuality || this.assessMetadataQuality(w);
      const isEnriched = quality.isEnriched;
      const sourceBadgeBg = isEnriched ? "#e0e7ff" : "#f1f5f9";
      const sourceBadgeColor = isEnriched ? "#3730a3" : "#475569";

      // Bibliographic detail line
      const bibDetails = [];
      if (w.journalTitle) bibDetails.push(w.journalTitle);
      if (w.volume) bibDetails.push(`Vol. ${w.volume}`);
      if (w.issue) bibDetails.push(`No. ${w.issue}`);
      if (w.pages || w.page) bibDetails.push(`pp. ${w.pages || w.page}`);

      // 1. Top row: Title + badges
      const topRow = doc.createElement("div");
      topRow.style.cssText = "display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;";

      const titleEl = doc.createElement("div");
      titleEl.style.cssText = "font-weight:600;font-size:0.95rem;color:#0f172a;line-height:1.35;";
      titleEl.textContent = w.title || "(Untitled Publication)";
      topRow.appendChild(titleEl);

      const badgesDiv = doc.createElement("div");
      badgesDiv.style.cssText = "display:flex;gap:4px;align-items:center;flex-shrink:0;";

      const sourceBadge = doc.createElement("span");
      sourceBadge.style.cssText = `font-size:0.72rem;font-weight:600;padding:2px 7px;border-radius:9999px;background:${sourceBadgeBg};color:${sourceBadgeColor};white-space:nowrap;`;
      sourceBadge.textContent = quality.sourceSummary || "ORCID";
      badgesDiv.appendChild(sourceBadge);

      const dupBadge = doc.createElement("span");
      dupBadge.style.cssText = `font-size:0.72rem;font-weight:600;padding:2px 7px;border-radius:9999px;background:${pillBg};color:${pillColor};white-space:nowrap;`;
      dupBadge.textContent = w.duplicateStatus || "New";
      badgesDiv.appendChild(dupBadge);

      topRow.appendChild(badgesDiv);
      contentCol.appendChild(topRow);

      // 2. Authors line
      const authorsEl = doc.createElement("div");
      authorsEl.style.cssText = "font-size:0.85rem;color:#475569;margin-bottom:4px;";
      authorsEl.textContent = authorsText;
      contentCol.appendChild(authorsEl);

      // 3. Bibliographic details (journal, volume, issue, pages)
      if (bibDetails.length > 0) {
        const bibEl = doc.createElement("div");
        bibEl.style.cssText = "font-size:0.82rem;color:#334155;margin-bottom:4px;font-style:italic;";
        bibEl.textContent = bibDetails.join(" • ");
        contentCol.appendChild(bibEl);
      }

      // 4. Metadata details (Year, DOI, Type, ISSN)
      const metaRow = doc.createElement("div");
      metaRow.style.cssText = "font-size:0.78rem;color:#64748b;display:flex;flex-wrap:wrap;gap:12px;margin-bottom:4px;";

      const addMetaItem = (label, val) => {
        const span = doc.createElement("span");
        span.textContent = `${label}: ${val}`;
        metaRow.appendChild(span);
      };

      addMetaItem("Year", w.year || "N/A");
      addMetaItem("DOI", w.doi || "None");
      addMetaItem("Type", w.type || "work");
      if (w.issn) addMetaItem("ISSN", w.issn);
      contentCol.appendChild(metaRow);

      // 5. Quality indicators (Enriched / Missing)
      if ((quality.enrichedFields && quality.enrichedFields.length > 0) || (quality.missingFields && quality.missingFields.length > 0)) {
        const qualityRow = doc.createElement("div");
        qualityRow.style.cssText = "margin-top:4px;display:flex;flex-wrap:wrap;gap:6px;";

        if (quality.enrichedFields && quality.enrichedFields.length > 0) {
          const enrichedPill = doc.createElement("span");
          enrichedPill.style.cssText = "font-size:0.72rem;background:#ecfdf5;color:#065f46;padding:1px 6px;border-radius:4px;font-weight:500;";
          enrichedPill.textContent = `Enriched (${quality.enrichedFields.join(", ")})`;
          qualityRow.appendChild(enrichedPill);
        }

        if (quality.missingFields && quality.missingFields.length > 0) {
          const topMissing = quality.missingFields.slice(0, 3).join(", ");
          const missingPill = doc.createElement("span");
          missingPill.style.cssText = "font-size:0.72rem;background:#fef2f2;color:#991b1b;padding:1px 6px;border-radius:4px;font-weight:500;";
          missingPill.textContent = `Missing: ${topMissing}`;
          qualityRow.appendChild(missingPill);
        }

        contentCol.appendChild(qualityRow);
      }

      // 6. Match reason (for duplicates)
      const matchEl = doc.createElement("div");
      matchEl.style.cssText = "margin-top:4px;font-size:0.78rem;font-style:italic;color:#b45309;";
      if (w.matchReason && w.duplicateStatus !== "New") {
        matchEl.textContent = w.matchReason;
        matchEl.style.display = "block";
      } else {
        matchEl.style.display = "none";
      }
      contentCol.appendChild(matchEl);

      // Register card updater for destination changes
      cardUpdaters.push(() => {
        let pBg = "#dcfce7";
        let pCol = "#166534";
        if (w.duplicateStatus === "Already in Zotero") {
          pBg = "#e2e8f0";
          pCol = "#475569";
        } else if (w.duplicateStatus === "Possible Duplicate") {
          pBg = "#fef3c7";
          pCol = "#92400e";
        }
        dupBadge.style.background = pBg;
        dupBadge.style.color = pCol;
        dupBadge.textContent = w.duplicateStatus || "New";

        if (w.matchReason && w.duplicateStatus !== "New") {
          matchEl.textContent = w.matchReason;
          matchEl.style.display = "block";
        } else {
          matchEl.style.display = "none";
        }
      });

      card.appendChild(cbCol);
      card.appendChild(contentCol);
      body.appendChild(card);
    });

    // Wire up library dropdown changes to dynamically re-evaluate duplicates
    libSelect.addEventListener("change", async (e) => {
      const newLibID = parseInt(e.target.value, 10) || 1;
      currentSelectedLibID = newLibID;
      currentSelectedColID = null;
      populateCollections(newLibID);

      try {
        const freshItems = await this.getLocalLibraryItems(newLibID);
        const rechecked = this.detectDuplicates(works, freshItems);
        works.forEach((w, i) => {
          const fresh = rechecked[i];
          if (fresh) {
            w.duplicateStatus = fresh.duplicateStatus;
            w.matchReason = fresh.matchReason;
            w.matchType = fresh.matchType;
            w.matchedItem = fresh.matchedItem;
          }
        });
        const freshStats = this.computeDuplicateStats(works);
        result.duplicateStats = freshStats;
        badgeAlready.textContent = `Already in Zotero: ${freshStats.alreadyCount}`;
        badgePossible.textContent = `Possible Duplicate: ${freshStats.possibleCount}`;
        badgeNew.textContent = `New: ${freshStats.newCount}`;

        cardUpdaters.forEach(fn => fn());
        updateUI();
        footerInfo.textContent = `Destination: ${this.getTargetLibraryName(currentSelectedLibID)} • Strictly read-only from ORCID`;
      } catch (err) {
        this.logError(err);
      }
    });

    colSelect.addEventListener("change", (e) => {
      currentSelectedColID = e.target.value ? (parseInt(e.target.value, 10) || e.target.value) : null;
    });

    modal.appendChild(body);

    // Footer
    const footer = doc.createElement("div");
    footer.style.cssText = "padding:14px 20px;border-top:1px solid #e2e8f0;background:#f8fafc;display:flex;justify-content:space-between;align-items:center;";

    const footerInfo = doc.createElement("div");
    footerInfo.style.cssText = "font-size:0.8rem;color:#64748b;";
    footerInfo.textContent = `Destination: ${this.getTargetLibraryName(currentSelectedLibID)} • Strictly read-only from ORCID`;

    const footerActions = doc.createElement("div");
    footerActions.style.cssText = "display:flex;gap:10px;";

    const btnCancel = doc.createElement("button");
    btnCancel.textContent = "Cancel";
    btnCancel.style.cssText = "padding:7px 14px;font-size:0.88rem;background:#ffffff;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer;color:#334155;";
    btnCancel.addEventListener("click", () => overlay.remove());

    const btnImport = doc.createElement("button");
    btnImport.style.cssText = "padding:7px 18px;font-size:0.88rem;font-weight:600;background:#2563eb;color:#ffffff;border:none;border-radius:6px;cursor:pointer;";

    footerActions.appendChild(btnCancel);
    footerActions.appendChild(btnImport);
    footer.appendChild(footerInfo);
    footer.appendChild(footerActions);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    (doc.body || doc.documentElement).appendChild(overlay);
    this.storeAddedElement("orcid-assistant-modal-overlay");

    // Dynamic UI update function
    const updateUI = () => {
      let selectedCount = 0;
      let possibleDupsCount = 0;
      let alreadyCount = 0;

      works.forEach((w, i) => {
        if (checkboxes[i].checked) {
          selectedCount++;
          if (w.duplicateStatus === "Possible Duplicate") possibleDupsCount++;
          if (w.duplicateStatus === "Already in Zotero") alreadyCount++;
        }
      });

      selectionSummary.textContent = `${selectedCount} of ${works.length} selected`;
      btnImport.textContent = `Import Selected (${selectedCount})`;
      btnImport.disabled = (selectedCount === 0);
      btnImport.style.background = (selectedCount === 0) ? "#94a3b8" : "#2563eb";

      if (possibleDupsCount > 0 || alreadyCount > 0) {
        warningBanner.style.display = "block";
        warningBanner.textContent = `⚠ Warning: ${possibleDupsCount + alreadyCount} record(s) flagged as Possible Duplicate / Already in Zotero selected. Explicit confirmation will be required before saving.`;
      } else {
        warningBanner.style.display = "none";
      }
    };

    // Button event listeners
    btnSelectNew.addEventListener("click", () => {
      works.forEach((w, i) => {
        const isNew = (w.duplicateStatus === "New");
        w.selected = isNew;
        checkboxes[i].checked = isNew;
      });
      updateUI();
    });

    btnClearSelection.addEventListener("click", () => {
      works.forEach((w, i) => {
        w.selected = false;
        checkboxes[i].checked = false;
      });
      updateUI();
    });

    btnImport.addEventListener("click", async () => {
      const selectedWorks = works.filter((w, i) => checkboxes[i].checked);
      if (selectedWorks.length === 0) return;

      // 1. Cautious confirmation for Possible Duplicates / Already in Library
      const possibleDups = selectedWorks.filter(w => w.duplicateStatus === "Possible Duplicate" || w.duplicateStatus === "Already in Zotero");
      if (possibleDups.length > 0) {
        const proceedWithDups = this.confirmPossibleDuplicates(window, possibleDups);
        if (!proceedWithDups) {
          return;
        }
      }

      // 2. Final confirmation dialog
      const proceed = this.confirmImport(window, selectedWorks, currentSelectedLibID, currentSelectedColID);
      if (!proceed) {
        return;
      }

      // 3. Execute import
      btnImport.disabled = true;
      btnImport.textContent = "Importing...";
      btnCancel.disabled = true;

      try {
        const importRes = await this.importPublications(selectedWorks, currentSelectedLibID, currentSelectedColID);

        // 4. Report summary
        let summaryMsg = `Import completed!\n\n` +
          `✔ Successfully imported: ${importRes.imported} publication(s)\n` +
          `⚠ Skipped (duplicates): ${importRes.skipped}\n` +
          `❌ Failed: ${importRes.failed}`;
        if (importRes.errors && importRes.errors.length > 0) {
          summaryMsg += `\n\nErrors:\n` + importRes.errors.map(e => `• ${e.title}: ${e.error}`).join("\n");
        }

        if (typeof Services !== "undefined" && Services.prompt) {
          Services.prompt.alert(window, "ORCID Assistant - Import Summary", summaryMsg);
        }

        // 5. Refresh modal statuses and duplicate detection safely
        try {
          const updatedLocalItems = await this.getLocalLibraryItems(currentSelectedLibID);
          const refreshedWorks = this.detectDuplicates(works, updatedLocalItems);
          result.works = refreshedWorks;
          result.duplicateStats = this.computeDuplicateStats(refreshedWorks);

          // Close and reopen refreshed modal
          overlay.remove();
          this.showImportModal(window, result);
        } catch (refreshErr) {
          this.logError(`Modal refresh notice (import succeeded): ${refreshErr.message}`);
          overlay.remove();
        }
      } catch (err) {
        this.logError(err);
        btnImport.disabled = false;
        btnCancel.disabled = false;
        if (typeof Services !== "undefined" && Services.prompt) {
          Services.prompt.alert(window, "ORCID Assistant - Import Error", `An error occurred during import: ${err.message}`);
        }
      }
    });

    // Initial render
    updateUI();
  },

  /**
   * Headless / prompt-based fallback for environments without DOM modal rendering.
   */
  async promptImportSelectionFallback(window, result) {
    const promptService = (typeof Services !== "undefined" && Services.prompt) ? Services.prompt : null;
    const previewText = this.formatWorksPreview(result);
    const totalCount = result.totalWorks ?? result.data?.totalWorks ?? (result.works?.length || 0);

    if (promptService && typeof promptService.alert === "function") {
      promptService.alert(
        window || null,
        `ORCID Public Works Preview (${totalCount} works found)`,
        previewText
      );
    }

    const newWorks = (result.works || []).filter(w => w.duplicateStatus === "New");
    if (newWorks.length === 0) {
      if (promptService && typeof promptService.alert === "function") {
        promptService.alert(
          window || null,
          "ORCID Assistant",
          "No new publications available for import."
        );
      }
      return;
    }

    const confirmImport = promptService && typeof promptService.confirm === "function"
      ? promptService.confirm(
          window || null,
          "ORCID Assistant - Confirm Import",
          `Would you like to import ${newWorks.length} new publication(s) into your local Zotero library?`
        )
      : false;

    if (confirmImport) {
      const targetLibraryID = this.getTargetLibraryID();
      const importRes = await this.importPublications(newWorks, targetLibraryID);
      if (promptService && typeof promptService.alert === "function") {
        promptService.alert(
          window || null,
          "ORCID Assistant - Import Complete",
          `Import finished:\n✔ Successfully imported: ${importRes.imported}\n⚠ Skipped: ${importRes.skipped}\n❌ Failed: ${importRes.failed}`
        );
      }
    }
  },

  /**
   * Parse ORCID iDs and optional researcher names from CSV, TSV, or plain text.
   * Validates format and checksum, deduplicates identical ORCID iDs, and extracts researcher names.
   */
  parseOrcidsFromCsvOrText(rawText) {
    if (!rawText || typeof rawText !== "string") {
      return {
        profiles: [],
        totalFound: 0,
        duplicatesInFile: 0,
        invalidCount: 0,
        invalidEntries: []
      };
    }

    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) {
      return {
        profiles: [],
        totalFound: 0,
        duplicatesInFile: 0,
        invalidCount: 0,
        invalidEntries: []
      };
    }

    const profilesMap = new Map();
    let duplicatesInFile = 0;
    const invalidEntries = [];

    // Check if line 1 looks like a CSV/TSV header
    let headerOrcidIdx = -1;
    let headerNameIdx = -1;
    let hasHeader = false;
    let delimiter = ",";

    const firstLine = lines[0];
    if (firstLine.includes("\t")) delimiter = "\t";
    else if (firstLine.includes(";")) delimiter = ";";
    else delimiter = ",";

    const headerCols = firstLine.split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ""));
    const orcidColRegex = /^(orcid|orcid[-_\s]?id|identifier)$/i;
    const nameColRegex = /^(name|researcher|author|faculty|person|member|full[-_\s]?name)$/i;

    headerCols.forEach((col, idx) => {
      if (orcidColRegex.test(col)) headerOrcidIdx = idx;
      if (nameColRegex.test(col)) headerNameIdx = idx;
    });

    if (headerOrcidIdx !== -1) {
      hasHeader = true;
    }

    const startLineIdx = hasHeader ? 1 : 0;
    const orcidRegex = /(?:https?:\/\/orcid\.org\/)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i;

    for (let i = startLineIdx; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.startsWith("#")) continue;

      let candidateOrcid = null;
      let candidateName = null;

      if (hasHeader) {
        const cols = line.split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ""));
        candidateOrcid = cols[headerOrcidIdx] || "";
        if (headerNameIdx !== -1 && cols[headerNameIdx]) {
          candidateName = cols[headerNameIdx];
        } else {
          if (headerOrcidIdx !== 0 && cols[0]) {
            candidateName = cols[0];
          }
        }
      } else {
        const match = line.match(orcidRegex);
        if (match) {
          candidateOrcid = match[0];
          const lineWithoutOrcid = line.replace(candidateOrcid, "").replace(/[,;\-\t|]+/g, " ").trim();
          if (lineWithoutOrcid.length > 1 && !lineWithoutOrcid.match(/^\d+$/)) {
            candidateName = lineWithoutOrcid.replace(/^["']|["']$/g, "").trim();
          }
        } else {
          if (/[\d-]{10,}/.test(line)) {
            invalidEntries.push({ raw: line, error: "Invalid ORCID format or check digit" });
          }
          continue;
        }
      }

      if (!candidateOrcid) continue;

      const validation = this.validateAndNormalizeOrcid(candidateOrcid);
      if (!validation.valid) {
        invalidEntries.push({ raw: candidateOrcid, error: validation.error || "Invalid ORCID" });
        continue;
      }

      const normOrcid = validation.orcid;
      if (profilesMap.has(normOrcid)) {
        duplicatesInFile++;
        const existing = profilesMap.get(normOrcid);
        if (!existing.name && candidateName) {
          existing.name = candidateName;
        }
      } else {
        profilesMap.set(normOrcid, {
          orcid: normOrcid,
          name: candidateName || null,
          sourceRow: i + 1
        });
      }
    }

    const profiles = Array.from(profilesMap.values());
    return {
      profiles,
      totalFound: profiles.length,
      duplicatesInFile,
      invalidCount: invalidEntries.length,
      invalidEntries
    };
  },

  /**
   * Popup modal dialog displaying duplicate publications detected across profiles.
   */
  showDuplicateReportPopup(window, reportData = {}) {
    const doc = window?.document;
    if (!doc) return;

    const existingOverlay = doc.getElementById("orcid-duplicate-report-overlay");
    if (existingOverlay) {
      existingOverlay.remove();
    }

    const duplicates = Array.isArray(reportData.duplicates) ? reportData.duplicates : [];
    const profilesCount = reportData.profilesCount || 1;
    const libraryName = reportData.libraryName || "Selected Library";

    const overlay = doc.createElement("div");
    overlay.id = "orcid-duplicate-report-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;background-color:rgba(0,0,0,0.6);display:flex;justify-content:center;align-items:center;z-index:1000000;font-family:system-ui,-apple-system,sans-serif;box-sizing:border-box;";

    const modal = doc.createElement("div");
    modal.id = "orcid-duplicate-report-modal";
    modal.style.cssText = "width:720px;max-width:92vw;max-height:85vh;background:#ffffff;color:#1e293b;border-radius:10px;box-shadow:0 25px 30px -5px rgba(0,0,0,0.3);display:flex;flex-direction:column;overflow:hidden;border:1px solid #f59e0b;";

    // Header
    const header = doc.createElement("div");
    header.style.cssText = "padding:16px 20px;background:#fffbeb;border-bottom:1px solid #fde68a;display:flex;justify-content:space-between;align-items:center;";

    const headerText = doc.createElement("div");
    const headerTitle = doc.createElement("h3");
    headerTitle.style.cssText = "margin:0;font-size:1.15rem;font-weight:700;color:#92400e;display:flex;align-items:center;gap:6px;";
    headerTitle.textContent = "⚠ Duplicate Publications Detected";

    const headerSub = doc.createElement("p");
    headerSub.style.cssText = "margin:4px 0 0 0;font-size:0.85rem;color:#b45309;";
    headerSub.textContent = `Found ${duplicates.length} duplicate publication(s) across ${profilesCount} profile(s) in ${libraryName}.`;

    headerText.appendChild(headerTitle);
    headerText.appendChild(headerSub);
    header.appendChild(headerText);

    const closeBtn = doc.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = "background:transparent;border:none;font-size:1.5rem;cursor:pointer;color:#92400e;line-height:1;padding:4px 8px;border-radius:4px;";
    closeBtn.addEventListener("click", () => overlay.remove());
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // Body: Scrollable list of duplicates
    const body = doc.createElement("div");
    body.style.cssText = "padding:16px 20px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:10px;background:#ffffff;";

    if (duplicates.length === 0) {
      const emptyMsg = doc.createElement("div");
      emptyMsg.style.cssText = "padding:20px;text-align:center;color:#64748b;font-size:0.9rem;";
      emptyMsg.textContent = "No duplicates were found. All publications appear to be new.";
      body.appendChild(emptyMsg);
    } else {
      duplicates.forEach((item, idx) => {
        const card = doc.createElement("div");
        card.style.cssText = "border:1px solid #e2e8f0;border-left:4px solid #f59e0b;border-radius:6px;padding:10px 14px;background:#fefce8;";

        const topRow = doc.createElement("div");
        topRow.style.cssText = "display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;";

        const titleEl = doc.createElement("div");
        titleEl.style.cssText = "font-weight:600;font-size:0.92rem;color:#0f172a;";
        titleEl.textContent = `${idx + 1}. ${item.title || "(Untitled Publication)"}`;
        topRow.appendChild(titleEl);

        const badge = doc.createElement("span");
        const isAlready = item.duplicateStatus === "Already in Zotero";
        badge.style.cssText = `font-size:0.72rem;font-weight:600;padding:2px 8px;border-radius:9999px;background:${isAlready ? "#e2e8f0" : "#fef3c7"};color:${isAlready ? "#475569" : "#92400e"};white-space:nowrap;`;
        badge.textContent = item.duplicateStatus || "Duplicate";
        topRow.appendChild(badge);
        card.appendChild(topRow);

        const metaRow = doc.createElement("div");
        metaRow.style.cssText = "font-size:0.8rem;color:#475569;margin-bottom:4px;display:flex;flex-wrap:wrap;gap:12px;";

        if (item.author || item.authors) {
          const authText = Array.isArray(item.authors) ? item.authors.join(", ") : (item.author || "");
          const authSpan = doc.createElement("span");
          authSpan.textContent = `Authors: ${authText}`;
          metaRow.appendChild(authSpan);
        }
        if (item.year) {
          const ySpan = doc.createElement("span");
          ySpan.textContent = `Year: ${item.year}`;
          metaRow.appendChild(ySpan);
        }
        if (item.doi) {
          const doiSpan = doc.createElement("span");
          doiSpan.textContent = `DOI: ${item.doi}`;
          metaRow.appendChild(doiSpan);
        }
        if (item.researcherName || item.orcid) {
          const rSpan = doc.createElement("span");
          rSpan.textContent = `Profile: ${item.researcherName ? item.researcherName + " (" + item.orcid + ")" : item.orcid}`;
          rSpan.style.color = "#1e40af";
          metaRow.appendChild(rSpan);
        }
        card.appendChild(metaRow);

        if (item.matchReason) {
          const reasonEl = doc.createElement("div");
          reasonEl.style.cssText = "font-size:0.78rem;font-style:italic;color:#92400e;background:#fffbeb;padding:4px 8px;border-radius:4px;";
          reasonEl.textContent = `Why flagged: ${item.matchReason}`;
          card.appendChild(reasonEl);
        }

        body.appendChild(card);
      });
    }

    modal.appendChild(body);

    // Footer
    const footer = doc.createElement("div");
    footer.style.cssText = "padding:12px 20px;border-top:1px solid #e2e8f0;background:#f8fafc;display:flex;justify-content:space-between;align-items:center;";

    const footerNote = doc.createElement("div");
    footerNote.style.cssText = "font-size:0.8rem;color:#64748b;";
    footerNote.textContent = "Duplicates are excluded from automatic selection.";

    const footerActions = doc.createElement("div");
    footerActions.style.cssText = "display:flex;gap:10px;";

    const btnDismiss = doc.createElement("button");
    btnDismiss.textContent = "Review Publications";
    btnDismiss.style.cssText = "padding:7px 14px;font-size:0.85rem;background:#ffffff;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer;color:#334155;";
    btnDismiss.addEventListener("click", () => {
      overlay.remove();
      if (typeof reportData.onReview === "function") {
        reportData.onReview();
      }
    });

    const btnExclude = doc.createElement("button");
    btnExclude.textContent = "Exclude All Duplicates";
    btnExclude.style.cssText = "padding:7px 16px;font-size:0.85rem;font-weight:600;background:#2563eb;color:#ffffff;border:none;border-radius:6px;cursor:pointer;";
    btnExclude.addEventListener("click", () => {
      overlay.remove();
      if (typeof reportData.onExcludeDuplicates === "function") {
        reportData.onExcludeDuplicates();
      }
    });

    footerActions.appendChild(btnDismiss);
    footerActions.appendChild(btnExclude);
    footer.appendChild(footerNote);
    footer.appendChild(footerActions);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    (doc.body || doc.documentElement).appendChild(overlay);
    this.storeAddedElement("orcid-duplicate-report-overlay");
  },

  /**
   * Interactive Batch CSV and Group Library Import Modal.
   */
  showBatchImportModal(window, options = {}) {
    const doc = window?.document;
    if (!doc) return;

    const existingOverlay = doc.getElementById("orcid-assistant-batch-modal-overlay");
    if (existingOverlay) {
      existingOverlay.remove();
    }

    const overlay = doc.createElement("div");
    overlay.id = "orcid-assistant-batch-modal-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;background-color:rgba(0,0,0,0.5);display:flex;justify-content:center;align-items:center;z-index:999999;font-family:system-ui,-apple-system,sans-serif;box-sizing:border-box;";

    const modal = doc.createElement("div");
    modal.id = "orcid-assistant-batch-modal";
    modal.style.cssText = "width:840px;max-width:94vw;max-height:90vh;background:#ffffff;color:#1e293b;border-radius:10px;box-shadow:0 20px 25px -5px rgba(0,0,0,0.25);display:flex;flex-direction:column;overflow:hidden;border:1px solid #cbd5e1;";

    // 1. Header
    const header = doc.createElement("div");
    header.style.cssText = "padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;background:#f8fafc;";

    const headerText = doc.createElement("div");
    const headerTitle = doc.createElement("h3");
    headerTitle.style.cssText = "margin:0;font-size:1.15rem;font-weight:700;color:#0f172a;";
    headerTitle.textContent = "ORCID Assistant — Batch CSV & Group Import";

    const headerSub = doc.createElement("p");
    headerSub.style.cssText = "margin:4px 0 0 0;font-size:0.85rem;color:#64748b;";
    headerSub.textContent = "Import multiple researcher profiles and select target Group Library or Collection.";

    headerText.appendChild(headerTitle);
    headerText.appendChild(headerSub);
    header.appendChild(headerText);

    const closeBtn = doc.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = "background:transparent;border:none;font-size:1.5rem;cursor:pointer;color:#64748b;line-height:1;padding:4px 8px;border-radius:4px;";
    closeBtn.addEventListener("click", () => overlay.remove());
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // 2. Destination Selection Bar (User Library / Group Libraries & Collections)
    const destBar = doc.createElement("div");
    destBar.id = "orcid-batch-dest-bar";
    destBar.style.cssText = "padding:10px 20px;background:#f8fafc;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;flex-wrap:wrap;gap:12px;";

    const destLabel = doc.createElement("span");
    destLabel.style.cssText = "font-size:0.83rem;font-weight:600;color:#334155;";
    destLabel.textContent = "Destination Library / Group:";
    destBar.appendChild(destLabel);

    const libSelect = doc.createElement("select");
    libSelect.id = "orcid-batch-library-select";
    libSelect.style.cssText = "padding:4px 8px;font-size:0.82rem;border:1px solid #cbd5e1;border-radius:4px;background:#ffffff;color:#1e293b;max-width:240px;";

    const destinations = this.getAvailableDestinations();
    let currentSelectedLibID = destinations.defaultLibraryID || 1;
    let currentSelectedColID = destinations.defaultCollectionID || null;

    destinations.libraries.forEach(lib => {
      const opt = doc.createElement("option");
      opt.value = String(lib.id);
      opt.textContent = lib.isGroup ? `[Group] ${lib.name}` : lib.name;
      if (lib.id === currentSelectedLibID || String(lib.id) === String(currentSelectedLibID)) {
        opt.selected = true;
      }
      libSelect.appendChild(opt);
    });
    destBar.appendChild(libSelect);

    const colLabel = doc.createElement("span");
    colLabel.style.cssText = "font-size:0.83rem;font-weight:600;color:#334155;margin-left:4px;";
    colLabel.textContent = "Collection:";
    destBar.appendChild(colLabel);

    const colSelect = doc.createElement("select");
    colSelect.id = "orcid-batch-collection-select";
    colSelect.style.cssText = "padding:4px 8px;font-size:0.82rem;border:1px solid #cbd5e1;border-radius:4px;background:#ffffff;color:#1e293b;max-width:200px;";

    const populateCollections = (libID) => {
      while (colSelect.firstChild) {
        colSelect.removeChild(colSelect.firstChild);
      }
      const rootOpt = doc.createElement("option");
      rootOpt.value = "";
      rootOpt.textContent = "(Entire Library / Root)";
      colSelect.appendChild(rootOpt);

      const targetLib = destinations.libraries.find(l => l.id === libID || String(l.id) === String(libID));
      if (targetLib && Array.isArray(targetLib.collections)) {
        targetLib.collections.forEach(c => {
          const opt = doc.createElement("option");
          opt.value = String(c.id);
          opt.textContent = c.name;
          if (c.id === currentSelectedColID || String(c.id) === String(currentSelectedColID)) {
            opt.selected = true;
          }
          colSelect.appendChild(opt);
        });
      }
    };

    populateCollections(currentSelectedLibID);
    destBar.appendChild(colSelect);
    modal.appendChild(destBar);

    // 3. Batch Input Section (Upload CSV or Paste ORCIDs)
    const inputSection = doc.createElement("div");
    inputSection.id = "orcid-batch-input-section";
    inputSection.style.cssText = "padding:14px 20px;border-bottom:1px solid #e2e8f0;background:#f1f5f9;display:flex;flex-direction:column;gap:10px;";

    const inputRowTop = doc.createElement("div");
    inputRowTop.style.cssText = "display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;";

    const inputInstruct = doc.createElement("div");
    inputInstruct.style.cssText = "font-size:0.84rem;color:#334155;font-weight:500;";
    inputInstruct.textContent = "Upload a CSV/TSV file (with Name and ORCID columns) or paste a list of ORCID iDs below:";
    inputRowTop.appendChild(inputInstruct);

    const fileUploadContainer = doc.createElement("div");
    fileUploadContainer.style.cssText = "display:flex;align-items:center;gap:6px;";

    const fileInput = doc.createElement("input");
    fileInput.type = "file";
    fileInput.id = "orcid-batch-file-input";
    fileInput.accept = ".csv,.tsv,.txt";
    fileInput.style.cssText = "font-size:0.8rem;color:#475569;";
    fileUploadContainer.appendChild(fileInput);
    inputRowTop.appendChild(fileUploadContainer);
    inputSection.appendChild(inputRowTop);

    const textarea = doc.createElement("textarea");
    textarea.id = "orcid-batch-textarea";
    textarea.placeholder = "Paste CSV or list of ORCIDs here...\nExamples:\nName, ORCID\nDr. Alice Smith, 0000-0002-1825-0097\nDr. Bob Jones, 0000-0002-1694-233X\n\nOr simply list ORCID identifiers one per line:\n0000-0002-1825-0097\nhttps://orcid.org/0000-0002-1694-233X";
    textarea.rows = 4;
    textarea.style.cssText = "width:100%;box-sizing:border-box;padding:8px 10px;font-family:monospace;font-size:0.82rem;border:1px solid #cbd5e1;border-radius:6px;resize:vertical;";
    inputSection.appendChild(textarea);

    const parseStatusBar = doc.createElement("div");
    parseStatusBar.style.cssText = "display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;";

    const parsedCountBadge = doc.createElement("span");
    parsedCountBadge.id = "orcid-batch-parsed-badge";
    parsedCountBadge.style.cssText = "font-size:0.82rem;font-weight:600;color:#334155;";
    parsedCountBadge.textContent = "📋 Ready: 0 profiles identified";
    parseStatusBar.appendChild(parsedCountBadge);

    const btnFetch = doc.createElement("button");
    btnFetch.id = "orcid-batch-fetch-btn";
    btnFetch.textContent = "Fetch Publications & Check Duplicates";
    btnFetch.style.cssText = "padding:6px 14px;font-size:0.84rem;font-weight:600;background:#2563eb;color:#ffffff;border:none;border-radius:5px;cursor:pointer;";
    parseStatusBar.appendChild(btnFetch);
    inputSection.appendChild(parseStatusBar);

    // Progress Bar (hidden by default)
    const progressContainer = doc.createElement("div");
    progressContainer.id = "orcid-batch-progress-container";
    progressContainer.style.cssText = "display:none;flex-direction:column;gap:4px;margin-top:4px;";

    const progressTrack = doc.createElement("div");
    progressTrack.style.cssText = "width:100%;height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden;";

    const progressBar = doc.createElement("div");
    progressBar.style.cssText = "width:0%;height:100%;background:#2563eb;transition:width 0.2s;";
    progressTrack.appendChild(progressBar);
    progressContainer.appendChild(progressTrack);

    const progressText = doc.createElement("div");
    progressText.style.cssText = "font-size:0.78rem;color:#64748b;";
    progressText.textContent = "Starting...";
    progressContainer.appendChild(progressText);

    inputSection.appendChild(progressContainer);
    modal.appendChild(inputSection);

    // 4. Works & Duplicates Toolbar (visible once fetched)
    const toolbar = doc.createElement("div");
    toolbar.id = "orcid-batch-toolbar";
    toolbar.style.cssText = "display:none;padding:12px 20px;background:#f8fafc;border-bottom:1px solid #e2e8f0;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;";

    const badgesContainer = doc.createElement("div");
    badgesContainer.style.cssText = "display:flex;gap:6px;align-items:center;";

    const makeBadge = (text, bg, color) => {
      const b = doc.createElement("span");
      b.style.cssText = `font-size:0.75rem;font-weight:600;padding:3px 8px;border-radius:9999px;background:${bg};color:${color};`;
      b.textContent = text;
      return b;
    };

    const badgeAlready = makeBadge("Already in Library: 0", "#e2e8f0", "#475569");
    const badgePossible = makeBadge("Possible Duplicate: 0", "#fef3c7", "#92400e");
    const badgeNew = makeBadge("New: 0", "#dcfce7", "#166534");

    badgesContainer.appendChild(badgeAlready);
    badgesContainer.appendChild(badgePossible);
    badgesContainer.appendChild(badgeNew);

    const actionsContainer = doc.createElement("div");
    actionsContainer.style.cssText = "display:flex;gap:8px;align-items:center;";

    const selectionSummary = doc.createElement("span");
    selectionSummary.id = "orcid-batch-selection-summary";
    selectionSummary.style.cssText = "font-size:0.82rem;font-weight:600;color:#334155;margin-right:4px;";

    const btnSelectNew = doc.createElement("button");
    btnSelectNew.textContent = "Select New";
    btnSelectNew.style.cssText = "padding:5px 10px;font-size:0.8rem;font-weight:500;background:#ffffff;border:1px solid #cbd5e1;border-radius:5px;cursor:pointer;color:#334155;";

    const btnClearSelection = doc.createElement("button");
    btnClearSelection.textContent = "Clear Selection";
    btnClearSelection.style.cssText = "padding:5px 10px;font-size:0.8rem;font-weight:500;background:#ffffff;border:1px solid #cbd5e1;border-radius:5px;cursor:pointer;color:#334155;";

    const btnViewDupReport = doc.createElement("button");
    btnViewDupReport.id = "orcid-batch-view-dups-btn";
    btnViewDupReport.textContent = "View Duplicate Report";
    btnViewDupReport.style.cssText = "padding:5px 10px;font-size:0.8rem;font-weight:600;background:#fef3c7;border:1px solid #fde68a;border-radius:5px;cursor:pointer;color:#92400e;display:none;";

    actionsContainer.appendChild(selectionSummary);
    actionsContainer.appendChild(btnSelectNew);
    actionsContainer.appendChild(btnClearSelection);
    actionsContainer.appendChild(btnViewDupReport);

    toolbar.appendChild(badgesContainer);
    toolbar.appendChild(actionsContainer);
    modal.appendChild(toolbar);

    // 5. Scrollable Body
    const body = doc.createElement("div");
    body.id = "orcid-batch-body";
    body.style.cssText = "padding:16px 20px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:12px;background:#ffffff;";

    const emptyHint = doc.createElement("div");
    emptyHint.style.cssText = "padding:30px 20px;text-align:center;color:#64748b;font-size:0.9rem;";
    emptyHint.textContent = "Upload a CSV file or paste ORCID iDs above, then click 'Fetch Publications & Check Duplicates'.";
    body.appendChild(emptyHint);
    modal.appendChild(body);

    // 6. Footer
    const footer = doc.createElement("div");
    footer.style.cssText = "padding:14px 20px;border-top:1px solid #e2e8f0;background:#f8fafc;display:flex;justify-content:space-between;align-items:center;";

    const footerInfo = doc.createElement("div");
    footerInfo.style.cssText = "font-size:0.8rem;color:#64748b;";
    footerInfo.textContent = `Destination: ${this.getTargetLibraryName(currentSelectedLibID)} • Strictly read-only from ORCID`;

    const footerActions = doc.createElement("div");
    footerActions.style.cssText = "display:flex;gap:10px;";

    const btnCancel = doc.createElement("button");
    btnCancel.textContent = "Cancel";
    btnCancel.style.cssText = "padding:7px 14px;font-size:0.88rem;background:#ffffff;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer;color:#334155;";
    btnCancel.addEventListener("click", () => overlay.remove());

    const btnImport = doc.createElement("button");
    btnImport.id = "orcid-batch-import-btn";
    btnImport.textContent = "Import Selected (0)";
    btnImport.disabled = true;
    btnImport.style.cssText = "padding:7px 18px;font-size:0.88rem;font-weight:600;background:#94a3b8;color:#ffffff;border:none;border-radius:6px;cursor:pointer;";

    footerActions.appendChild(btnCancel);
    footerActions.appendChild(btnImport);
    footer.appendChild(footerInfo);
    footer.appendChild(footerActions);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    (doc.body || doc.documentElement).appendChild(overlay);
    this.storeAddedElement("orcid-assistant-batch-modal-overlay");

    // Internal State
    let parsedData = { profiles: [], totalFound: 0, duplicatesInFile: 0, invalidCount: 0, invalidEntries: [] };
    let allWorks = [];
    let checkboxes = [];
    let lastDuplicateReport = null;

    const updateParsedProfiles = () => {
      const text = textarea.value || "";
      parsedData = this.parseOrcidsFromCsvOrText(text);

      let msg = `✔ Found ${parsedData.totalFound} researcher profile(s)`;
      if (parsedData.duplicatesInFile > 0) {
        msg += ` (${parsedData.duplicatesInFile} duplicate ORCIDs deduplicated)`;
      }
      if (parsedData.invalidCount > 0) {
        msg += ` (${parsedData.invalidCount} invalid format ignored)`;
      }
      if (parsedData.totalFound === 0) {
        msg = "📋 Ready: 0 profiles identified (Upload CSV or paste text above)";
      }
      parsedCountBadge.textContent = msg;
    };

    textarea.addEventListener("input", updateParsedProfiles);

    fileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (typeof FileReader !== "undefined") {
        const reader = new FileReader();
        reader.onload = (loadEvt) => {
          textarea.value = loadEvt.target.result;
          updateParsedProfiles();
        };
        reader.readAsText(file);
      } else if (file.text) {
        file.text().then(text => {
          textarea.value = text;
          updateParsedProfiles();
        });
      }
    });

    libSelect.addEventListener("change", async (e) => {
      const newLibID = parseInt(e.target.value, 10) || 1;
      currentSelectedLibID = newLibID;
      currentSelectedColID = null;
      populateCollections(newLibID);
      footerInfo.textContent = `Destination: ${this.getTargetLibraryName(currentSelectedLibID)} • Strictly read-only from ORCID`;

      if (allWorks.length > 0) {
        // Re-run duplicate detection against newly chosen library
        const localItems = await this.getLocalLibraryItems(currentSelectedLibID);
        allWorks = this.detectDuplicates(allWorks, localItems);
        renderPublications();
      }
    });

    colSelect.addEventListener("change", (e) => {
      currentSelectedColID = e.target.value ? (parseInt(e.target.value, 10) || e.target.value) : null;
    });

    const updateUI = () => {
      let selectedCount = 0;
      allWorks.forEach((w, i) => {
        if (checkboxes[i] && checkboxes[i].checked) {
          selectedCount++;
        }
      });

      selectionSummary.textContent = `${selectedCount} of ${allWorks.length} selected`;
      btnImport.textContent = `Import Selected (${selectedCount})`;
      btnImport.disabled = (selectedCount === 0);
      btnImport.style.background = (selectedCount === 0) ? "#94a3b8" : "#2563eb";
    };

    const renderPublications = () => {
      while (body.firstChild) {
        body.removeChild(body.firstChild);
      }
      checkboxes = [];

      if (allWorks.length === 0) {
        const noWorksMsg = doc.createElement("div");
        noWorksMsg.style.cssText = "padding:20px;text-align:center;color:#64748b;";
        noWorksMsg.textContent = "No public works were found for the entered ORCID profile(s).";
        body.appendChild(noWorksMsg);
        toolbar.style.display = "none";
        return;
      }

      toolbar.style.display = "flex";
      const stats = this.computeDuplicateStats(allWorks);
      badgeAlready.textContent = `Already in Library: ${stats.alreadyCount}`;
      badgePossible.textContent = `Possible Duplicate: ${stats.possibleCount}`;
      badgeNew.textContent = `New: ${stats.newCount}`;

      const dupsCount = stats.alreadyCount + stats.possibleCount;
      if (dupsCount > 0) {
        btnViewDupReport.style.display = "inline-block";
        btnViewDupReport.textContent = `View Duplicate Report (${dupsCount})`;
      } else {
        btnViewDupReport.style.display = "none";
      }

      allWorks.forEach((w, idx) => {
        const card = doc.createElement("div");
        card.className = "orcid-batch-work-card";
        card.style.cssText = "border:1px solid #e2e8f0;border-radius:6px;padding:12px;display:flex;gap:12px;background:#ffffff;";

        const cbCol = doc.createElement("div");
        cbCol.style.cssText = "padding-top:2px;";

        const cb = doc.createElement("input");
        cb.type = "checkbox";
        cb.checked = (w.selected !== undefined) ? !!w.selected : (w.duplicateStatus === "New");
        cb.style.cssText = "width:17px;height:17px;cursor:pointer;";
        cb.addEventListener("change", (e) => {
          w.selected = e.target.checked;
          updateUI();
        });
        checkboxes.push(cb);
        cbCol.appendChild(cb);

        const contentCol = doc.createElement("div");
        contentCol.style.cssText = "flex:1;min-width:0;";

        // Status pill styling
        let pillBg = "#dcfce7";
        let pillColor = "#166534";
        if (w.duplicateStatus === "Already in Zotero") {
          pillBg = "#e2e8f0";
          pillColor = "#475569";
        } else if (w.duplicateStatus === "Possible Duplicate") {
          pillBg = "#fef3c7";
          pillColor = "#92400e";
        }

        const topRow = doc.createElement("div");
        topRow.style.cssText = "display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;";

        const titleEl = doc.createElement("div");
        titleEl.style.cssText = "font-weight:600;font-size:0.95rem;color:#0f172a;line-height:1.35;";
        titleEl.textContent = w.title || "(Untitled Publication)";
        topRow.appendChild(titleEl);

        const badgesDiv = doc.createElement("div");
        badgesDiv.style.cssText = "display:flex;gap:4px;align-items:center;flex-shrink:0;";

        if (w.researcherName || w.researcherOrcid) {
          const rBadge = doc.createElement("span");
          rBadge.style.cssText = "font-size:0.72rem;font-weight:600;padding:2px 7px;border-radius:9999px;background:#eff6ff;color:#1e40af;white-space:nowrap;";
          rBadge.textContent = `👤 ${w.researcherName || w.researcherOrcid}`;
          badgesDiv.appendChild(rBadge);
        }

        const dupBadge = doc.createElement("span");
        dupBadge.style.cssText = `font-size:0.72rem;font-weight:600;padding:2px 7px;border-radius:9999px;background:${pillBg};color:${pillColor};white-space:nowrap;`;
        dupBadge.textContent = w.duplicateStatus || "New";
        badgesDiv.appendChild(dupBadge);

        topRow.appendChild(badgesDiv);
        contentCol.appendChild(topRow);

        const authorsText = Array.isArray(w.authors) && w.authors.length > 0
          ? w.authors.map(a => typeof a === "object" ? (a.fullName || a.lastName) : a).join(", ")
          : (w.author || "Not specified");

        const authorsEl = doc.createElement("div");
        authorsEl.style.cssText = "font-size:0.85rem;color:#475569;margin-bottom:4px;";
        authorsEl.textContent = authorsText;
        contentCol.appendChild(authorsEl);

        const metaRow = doc.createElement("div");
        metaRow.style.cssText = "font-size:0.78rem;color:#64748b;display:flex;flex-wrap:wrap;gap:12px;margin-bottom:4px;";

        const addMetaItem = (label, val) => {
          const span = doc.createElement("span");
          span.textContent = `${label}: ${val}`;
          metaRow.appendChild(span);
        };

        addMetaItem("Year", w.year || "N/A");
        addMetaItem("DOI", w.doi || "None");
        if (w.journalTitle) addMetaItem("Journal", w.journalTitle);
        contentCol.appendChild(metaRow);

        if (w.matchReason && w.duplicateStatus !== "New") {
          const matchEl = doc.createElement("div");
          matchEl.style.cssText = "margin-top:4px;font-size:0.78rem;font-style:italic;color:#b45309;";
          matchEl.textContent = w.matchReason;
          contentCol.appendChild(matchEl);
        }

        card.appendChild(cbCol);
        card.appendChild(contentCol);
        body.appendChild(card);
      });

      updateUI();
    };

    // Button event listeners
    btnSelectNew.addEventListener("click", () => {
      allWorks.forEach((w, i) => {
        const isNew = (w.duplicateStatus === "New");
        w.selected = isNew;
        if (checkboxes[i]) checkboxes[i].checked = isNew;
      });
      updateUI();
    });

    btnClearSelection.addEventListener("click", () => {
      allWorks.forEach((w, i) => {
        w.selected = false;
        if (checkboxes[i]) checkboxes[i].checked = false;
      });
      updateUI();
    });

    btnViewDupReport.addEventListener("click", () => {
      if (lastDuplicateReport) {
        this.showDuplicateReportPopup(window, lastDuplicateReport);
      }
    });

    // Fetch publications button handler
    btnFetch.addEventListener("click", async () => {
      updateParsedProfiles();
      if (parsedData.profiles.length === 0) {
        if (typeof Services !== "undefined" && Services.prompt) {
          Services.prompt.alert(window, "ORCID Assistant", "Please upload a CSV file or enter at least one valid ORCID iD.");
        }
        return;
      }

      btnFetch.disabled = true;
      progressContainer.style.display = "flex";
      allWorks = [];

      const totalProfiles = parsedData.profiles.length;
      const fetchedWorksCollector = [];

      for (let i = 0; i < totalProfiles; i++) {
        const p = parsedData.profiles[i];
        const pct = Math.round(((i + 1) / totalProfiles) * 100);
        progressBar.style.width = `${pct}%`;
        progressText.textContent = `Fetching profile ${i + 1} of ${totalProfiles}: ${p.name || p.orcid} (${pct}%)...`;

        try {
          const res = await this.fetchWorksFromHelper(p.orcid);
          if (res.success) {
            const raw = Array.isArray(res.works) ? res.works : (Array.isArray(res.data?.works) ? res.data.works : []);
            raw.forEach(w => {
              w.researcherName = p.name || null;
              w.researcherOrcid = p.orcid;
              w.orcid = p.orcid;
            });
            fetchedWorksCollector.push(...raw);
          } else {
            this.log(`Notice: could not fetch works for ${p.orcid}: ${res.error}`);
          }
        } catch (fetchErr) {
          this.logError(fetchErr);
        }
      }

      progressText.textContent = `Checking duplicates against ${this.getTargetLibraryName(currentSelectedLibID)}...`;

      // Evaluate duplicates against destination library
      const localItems = await this.getLocalLibraryItems(currentSelectedLibID);
      const annotated = this.detectDuplicates(fetchedWorksCollector, localItems);

      // Intra-batch duplicate prevention (if multiple researchers share a publication in this batch)
      const seenBatchDois = new Map();
      const seenBatchTitles = new Map();

      for (const work of annotated) {
        const normDoi = this.normalizeDoi(work.doi);
        const normTitle = this.normalizeTitle(work.title);

        if (normDoi) {
          if (seenBatchDois.has(normDoi)) {
            const first = seenBatchDois.get(normDoi);
            work.duplicateStatus = "Already in Zotero";
            work.matchType = "INTRA_BATCH_DOI";
            work.matchReason = `Intra-batch duplicate: already fetched for ${first.researcherName || first.researcherOrcid || "another researcher"}`;
          } else {
            seenBatchDois.set(normDoi, work);
          }
        } else if (normTitle) {
          const workYear = this.extractYear(work.year);
          if (seenBatchTitles.has(normTitle)) {
            const first = seenBatchTitles.get(normTitle);
            const firstYear = this.extractYear(first.year);
            if (workYear && firstYear && workYear === firstYear) {
              work.duplicateStatus = "Possible Duplicate";
              work.matchType = "INTRA_BATCH_TITLE";
              work.matchReason = `Intra-batch duplicate: matching title and year with publication from ${first.researcherName || first.researcherOrcid || "another researcher"}`;
            }
          } else {
            seenBatchTitles.set(normTitle, work);
          }
        }
      }

      allWorks = annotated;
      allWorks.forEach(w => {
        w.selected = (w.duplicateStatus === "New");
      });

      const duplicatesFound = allWorks.filter(w => w.duplicateStatus !== "New");
      lastDuplicateReport = {
        duplicates: duplicatesFound,
        profilesCount: totalProfiles,
        libraryName: this.getTargetLibraryName(currentSelectedLibID),
        onReview: () => {},
        onExcludeDuplicates: () => {
          allWorks.forEach((w, i) => {
            const isNew = (w.duplicateStatus === "New");
            w.selected = isNew;
            if (checkboxes[i]) checkboxes[i].checked = isNew;
          });
          updateUI();
        }
      };

      progressContainer.style.display = "none";
      btnFetch.disabled = false;

      renderPublications();

      // Explicit User Requirement: "checks duplicates and flag then and give popup these are duplicates"
      if (duplicatesFound.length > 0) {
        this.showDuplicateReportPopup(window, lastDuplicateReport);
      }
    });

    // Import Selected button handler
    btnImport.addEventListener("click", async () => {
      const selectedWorks = allWorks.filter((w, i) => checkboxes[i] && checkboxes[i].checked);
      if (selectedWorks.length === 0) return;

      const possibleDups = selectedWorks.filter(w => w.duplicateStatus === "Possible Duplicate" || w.duplicateStatus === "Already in Zotero");
      if (possibleDups.length > 0) {
        const proceedWithDups = this.confirmPossibleDuplicates(window, possibleDups);
        if (!proceedWithDups) return;
      }

      const proceed = this.confirmImport(window, selectedWorks, currentSelectedLibID, currentSelectedColID);
      if (!proceed) return;

      btnImport.disabled = true;
      btnImport.textContent = "Importing...";
      btnCancel.disabled = true;

      try {
        const importRes = await this.importPublications(selectedWorks, currentSelectedLibID, currentSelectedColID);

        let summaryMsg = `Batch import completed!\n\n` +
          `✔ Successfully imported: ${importRes.imported} publication(s)\n` +
          `⚠ Skipped (duplicates): ${importRes.skipped}\n` +
          `❌ Failed: ${importRes.failed}\n\n` +
          `Destination: ${this.getTargetLibraryName(currentSelectedLibID)}` +
          (currentSelectedColID ? ` > ${this.getTargetCollectionName(currentSelectedLibID, currentSelectedColID)}` : "");

        if (importRes.errors && importRes.errors.length > 0) {
          summaryMsg += `\n\nErrors:\n` + importRes.errors.map(e => `• ${e.title}: ${e.error}`).join("\n");
        }

        if (typeof Services !== "undefined" && Services.prompt) {
          Services.prompt.alert(window, "ORCID Assistant - Batch Import Summary", summaryMsg);
        }

        overlay.remove();
      } catch (err) {
        this.logError(err);
        btnImport.disabled = false;
        btnCancel.disabled = false;
        if (typeof Services !== "undefined" && Services.prompt) {
          Services.prompt.alert(window, "ORCID Assistant - Import Error", `An error occurred during batch import: ${err.message}`);
        }
      }
    });
  },

  /**
   * Headless / prompt-based fallback for Batch CSV import.
   */
  async promptBatchImportFallback(window) {
    const promptService = (typeof Services !== "undefined" && Services.prompt) ? Services.prompt : null;
    if (!promptService || typeof promptService.prompt !== "function") {
      this.showRunningDialog(window);
      return;
    }

    const inputVal = { value: "" };
    const checkVal = { value: false };
    const confirmed = promptService.prompt(
      window || null,
      "ORCID Assistant - Batch CSV Import",
      "Enter a comma-separated or newline-separated list of ORCID iDs:\n(e.g., 0000-0002-1825-0097, 0000-0002-1694-233X)",
      inputVal,
      null,
      checkVal
    );

    if (!confirmed || !inputVal.value.trim()) return;

    const parsed = this.parseOrcidsFromCsvOrText(inputVal.value);
    if (parsed.profiles.length === 0) {
      if (promptService.alert) {
        promptService.alert(window || null, "ORCID Assistant", "No valid ORCID iDs were found in the input.");
      }
      return;
    }

    const destinations = this.getAvailableDestinations();
    const targetLibraryID = destinations.defaultLibraryID || 1;
    const libraryName = this.getTargetLibraryName(targetLibraryID);

    const allWorks = [];
    for (const profile of parsed.profiles) {
      const res = await this.fetchWorksFromHelper(profile.orcid);
      if (res.success) {
        const raw = Array.isArray(res.works) ? res.works : (Array.isArray(res.data?.works) ? res.data.works : []);
        raw.forEach(w => {
          w.researcherName = profile.name;
          w.researcherOrcid = profile.orcid;
          w.orcid = profile.orcid;
        });
        allWorks.push(...raw);
      }
    }

    const localItems = await this.getLocalLibraryItems(targetLibraryID);
    const annotatedWorks = this.detectDuplicates(allWorks, localItems);

    const duplicates = annotatedWorks.filter(w => w.duplicateStatus !== "New");
    const newWorks = annotatedWorks.filter(w => w.duplicateStatus === "New");

    if (duplicates.length > 0 && promptService.alert) {
      promptService.alert(
        window || null,
        "ORCID Assistant - Duplicates Found",
        `Duplicate Check in ${libraryName}:\n` +
        `• Total works fetched: ${annotatedWorks.length}\n` +
        `• Duplicates detected: ${duplicates.length}\n` +
        `• New works available: ${newWorks.length}\n\n` +
        `Duplicates will be excluded from automatic import.`
      );
    }

    if (newWorks.length === 0) {
      if (promptService.alert) {
        promptService.alert(window || null, "ORCID Assistant", "No new publications found to import.");
      }
      return;
    }

    const proceed = promptService.confirm
      ? promptService.confirm(
          window || null,
          "ORCID Assistant - Confirm Import",
          `Import ${newWorks.length} new publication(s) into ${libraryName}?`
        )
      : false;

    if (proceed) {
      const importRes = await this.importPublications(newWorks, targetLibraryID);
      if (promptService.alert) {
        promptService.alert(
          window || null,
          "ORCID Assistant - Import Complete",
          `Import finished into ${libraryName}:\n✔ Imported: ${importRes.imported}\n⚠ Skipped: ${importRes.skipped}\n❌ Failed: ${importRes.failed}`
        );
      }
    }
  },

  /**
   * Callback when Batch CSV menu item is clicked.
   */
  onBatchMenuItemCommand(window) {
    this.log("Batch CSV Import menu entry clicked by user.");
    if (window && window.document && typeof window.document.createElement === "function" && (window.document.body || window.document.documentElement)) {
      this.showBatchImportModal(window);
    } else {
      this.promptBatchImportFallback(window).catch(err => this.logError(err));
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

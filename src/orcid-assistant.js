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

      let modal = doc.getElementById("orcid-assistant-modal-overlay");
      if (modal) {
        modal.remove();
        this.log("Removed active ORCID Assistant modal dialog.");
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
        const title = (typeof item.getField === "function") ? item.getField("title") : (item.title || "");
        const doi = (typeof item.getField === "function") ? (item.getField("DOI") || item.getField("doi")) : (item.DOI || item.doi || "");
        const dateVal = (typeof item.getField === "function") ? (item.getField("date") || item.getField("year")) : (item.date || item.year || "");
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
              ? ` & author (${authorMatch})`
              : "";
            return {
              ...work,
              duplicateStatus: "Possible Duplicate",
              matchType: "TITLE_YEAR",
              matchReason: `Title & year (${workYear})${authorDetail} match local item`,
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
              matchReason: `Title & author (${authorMatch}) match local item (year unavailable)`,
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
    return "My Library";
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
   * Create and populate a Zotero.Item instance from ORCID work metadata.
   */
  async createZoteroItem(work, targetLibraryID) {
    const zoteroType = this.mapOrcidTypeToZotero(work.type);
    const libID = this.getTargetLibraryID(targetLibraryID);

    let item;
    if (typeof Zotero !== "undefined" && typeof Zotero.Item === "function") {
      try {
        let typeID = (Zotero.ItemTypes && typeof Zotero.ItemTypes.getID === "function")
          ? Zotero.ItemTypes.getID(zoteroType)
          : zoteroType;
        item = new Zotero.Item(typeID || "journalArticle");
      } catch (e) {
        item = new Zotero.Item("journalArticle");
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
        setField(f, v) { this.fields[f] = v; },
        getField(f) { return this.fields[f]; },
        setCreators(c) { this.creators = c; },
        getCreators() { return this.creators; },
        async saveTx() { this.id = Math.floor(Math.random() * 100000) + 1; return this.id; }
      };
    }

    if (item && libID) {
      item.libraryID = libID;
    }

    // Title (required)
    const title = (work.title || "").trim() || "(Untitled ORCID Publication)";
    item.setField("title", title);

    // DOI (if available)
    const normDoi = this.normalizeDoi(work.doi);
    if (normDoi) {
      try {
        item.setField("DOI", normDoi);
      } catch (e) {
        try { item.setField("doi", normDoi); } catch (e2) {}
      }
    }

    // Publication Year / Date (if available)
    const year = this.extractYear(work.year);
    if (year) {
      try {
        item.setField("date", year);
      } catch (e) {}
    }

    // Publication / Journal Title (if available)
    if (work.journalTitle) {
      try {
        item.setField("publicationTitle", work.journalTitle);
      } catch (e) {
        try { item.setField("publisher", work.journalTitle); } catch (e2) {}
      }
    }

    // URL (if available)
    if (work.url) {
      try {
        item.setField("url", work.url);
      } catch (e) {}
    }

    // Extra provenance
    const extraLines = [];
    if (work.orcid) {
      extraLines.push(`ORCID: ${work.orcid}`);
    }
    if (work.putCode) {
      extraLines.push(`ORCID-Put-Code: ${work.putCode}`);
    }
    if (extraLines.length > 0) {
      try {
        const existingExtra = (typeof item.getField === "function") ? (item.getField("extra") || "") : "";
        const combined = existingExtra ? `${existingExtra}\n${extraLines.join("\n")}` : extraLines.join("\n");
        item.setField("extra", combined);
      } catch (e) {}
    }

    // Creators / Authors
    const authors = Array.isArray(work.authors) && work.authors.length > 0
      ? work.authors
      : (work.author ? [work.author] : []);

    if (authors.length > 0) {
      const creators = [];
      for (const a of authors) {
        if (!a || typeof a !== "string") continue;
        creators.push(this.parseAuthorName(a));
      }
      if (creators.length > 0) {
        try {
          item.setCreators(creators);
        } catch (e) {
          this.logError(e);
        }
      }
    }

    return item;
  },

  /**
   * Import selected publications into the local Zotero library.
   * Rechecks for duplicates immediately before saving to prevent duplicate imports.
   */
  async importPublications(selectedWorks, targetLibraryID) {
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
        const item = await this.createZoteroItem(work, libID);
        // Supported Zotero save mechanism
        if (typeof item.saveTx === "function") {
          await item.saveTx();
        } else if (typeof item.save === "function") {
          await item.save();
        }

        imported++;
        importedItems.push(item);
        this.log(`Successfully created Zotero item for: "${work.title}" (ID: ${item.id})`);

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
  confirmImport(window, selectedWorks, targetLibraryID) {
    const promptService = (typeof Services !== "undefined" && Services.prompt) ? Services.prompt : null;
    if (!promptService || typeof promptService.confirm !== "function") return true;

    const libID = this.getTargetLibraryID(targetLibraryID);
    const libraryName = this.getTargetLibraryName(libID);
    const newCount = selectedWorks.filter(w => w.duplicateStatus === "New").length;
    const possibleCount = selectedWorks.filter(w => w.duplicateStatus === "Possible Duplicate").length;
    const alreadyCount = selectedWorks.filter(w => w.duplicateStatus === "Already in Zotero").length;

    let breakdown = `• New records: ${newCount}`;
    if (possibleCount > 0) breakdown += `\n• Possible duplicates: ${possibleCount}`;
    if (alreadyCount > 0) breakdown += `\n• Already in library: ${alreadyCount}`;

    return promptService.confirm(
      window || null,
      "ORCID Assistant - Confirm Import",
      `You are about to import ${selectedWorks.length} publication(s) into your local Zotero library.\n\nDestination: ${libraryName}\n${breakdown}\n\nDo you want to proceed?`
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
    header.innerHTML = `
      <div>
        <h3 style="margin:0;font-size:1.15rem;font-weight:700;color:#0f172a;">ORCID Assistant — Public Works Import</h3>
        <p style="margin:4px 0 0 0;font-size:0.85rem;color:#64748b;">ORCID iD: <strong>${orcid}</strong> • ${totalCount} Public Works Found</p>
      </div>
    `;

    const closeBtn = doc.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = "background:transparent;border:none;font-size:1.5rem;cursor:pointer;color:#64748b;line-height:1;padding:4px 8px;border-radius:4px;";
    closeBtn.addEventListener("click", () => overlay.remove());
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // Toolbar / Stats Bar
    const stats = result.duplicateStats || this.computeDuplicateStats(works);
    const toolbar = doc.createElement("div");
    toolbar.style.cssText = "padding:12px 20px;background:#f1f5f9;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;";

    const badgesContainer = doc.createElement("div");
    badgesContainer.style.cssText = "display:flex;gap:6px;align-items:center;";
    badgesContainer.innerHTML = `
      <span style="font-size:0.75rem;font-weight:600;padding:3px 8px;border-radius:9999px;background:#e2e8f0;color:#475569;">Already in Zotero: ${stats.alreadyCount}</span>
      <span style="font-size:0.75rem;font-weight:600;padding:3px 8px;border-radius:9999px;background:#fef3c7;color:#92400e;">Possible Duplicate: ${stats.possibleCount}</span>
      <span style="font-size:0.75rem;font-weight:600;padding:3px 8px;border-radius:9999px;background:#dcfce7;color:#166534;">New: ${stats.newCount}</span>
    `;

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

      const authorsText = w.author || (Array.isArray(w.authors) && w.authors.length > 0 ? w.authors.join(", ") : "Not specified");

      contentCol.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;">
          <div style="font-weight:600;font-size:0.95rem;color:#0f172a;line-height:1.35;">${w.title || "(Untitled Publication)"}</div>
          <span style="font-size:0.75rem;font-weight:600;padding:2px 8px;border-radius:9999px;background:${pillBg};color:${pillColor};white-space:nowrap;">${w.duplicateStatus}</span>
        </div>
        <div style="font-size:0.85rem;color:#475569;margin-bottom:6px;">${authorsText}</div>
        <div style="font-size:0.8rem;color:#64748b;display:flex;flex-wrap:wrap;gap:12px;">
          <span><strong>Year:</strong> ${w.year || "N/A"}</span>
          <span><strong>DOI:</strong> ${w.doi || "None"}</span>
          <span><strong>Type:</strong> ${w.type || "work"}</span>
        </div>
        ${w.matchReason && w.duplicateStatus !== "New" ? `<div style="margin-top:6px;font-size:0.78rem;font-style:italic;color:#b45309;">${w.matchReason}</div>` : ""}
      `;

      card.appendChild(cbCol);
      card.appendChild(contentCol);
      body.appendChild(card);
    });

    modal.appendChild(body);

    // Footer
    const footer = doc.createElement("div");
    footer.style.cssText = "padding:14px 20px;border-top:1px solid #e2e8f0;background:#f8fafc;display:flex;justify-content:space-between;align-items:center;";

    const footerInfo = doc.createElement("div");
    footerInfo.style.cssText = "font-size:0.8rem;color:#64748b;";
    footerInfo.textContent = "Destination: Local Library • Strictly read-only from ORCID";

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
      const proceed = this.confirmImport(window, selectedWorks);
      if (!proceed) {
        return;
      }

      // 3. Execute import
      btnImport.disabled = true;
      btnImport.textContent = "Importing...";
      btnCancel.disabled = true;

      try {
        const targetLibraryID = this.getTargetLibraryID();
        const importRes = await this.importPublications(selectedWorks, targetLibraryID);

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

        // 5. Refresh modal statuses and duplicate detection
        const updatedLocalItems = await this.getLocalLibraryItems(targetLibraryID);
        const refreshedWorks = this.detectDuplicates(works, updatedLocalItems);
        result.works = refreshedWorks;
        result.duplicateStats = this.computeDuplicateStats(refreshedWorks);

        // Close and reopen refreshed modal
        overlay.remove();
        this.showImportModal(window, result);
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

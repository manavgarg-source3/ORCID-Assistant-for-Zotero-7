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

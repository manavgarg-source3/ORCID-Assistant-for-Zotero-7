# ORCID Assistant for Zotero 7+

**ORCID Assistant** is an open-source Zotero desktop plugin designed to streamline importing, verifying, and linking researcher publication records with [ORCID](https://orcid.org).

> **Step 1 Foundation Status:** Minimal plugin lifecycle foundation established. The plugin registers an "ORCID Assistant" menu entry in Zotero that confirms operational status via a dialog. No external network connections to ORCID or modifications to bibliographic items are performed in this step.

---

## 1. Architecture & Design

This plugin implements the restartless bootstrapped extension architecture required by **Zotero 7+** (Firefox 115+ Gecko runtime):

* **`src/manifest.json`**: WebExtension-style manifest with `manifest_version: 2`, specifying strict compatibility bounds (`7.0` to `20.*`) under `applications.zotero` and `browser_specific_settings.zotero`.
* **`src/bootstrap.js`**: Gecko restartless lifecycle hooks (`install`, `startup`, `shutdown`, `uninstall`, `onMainWindowLoad`, `onMainWindowUnload`).
* **`src/orcid-assistant.js`**: Core plugin logic. Implements UI injection into the main menubar (`Tools -> ORCID Assistant`) and context menus (`Zotero.MenuManager`).
* **`src/locale/en-US/orcid-assistant.ftl`**: Project Fluent localization strings.
* **`src/prefs.js`**: Default configuration entries (`extensions.orcid-assistant.*`).
* **`scripts/build.js`**: Packaging pipeline assembling `dist/orcid-assistant.xpi`.
* **`scripts/test.js`**: Automated verification test suite.

---

## 2. Prerequisites

* **Node.js**: v18+ (tested on Node v24.18.0)
* **Zotero Desktop**: Zotero 7.0+ (compatible with Zotero 7 and later releases)

---

## 3. Building and Automated Testing

### Install Dependencies
```bash
npm install
```

### Build the `.xpi` Package
```bash
npm run build
```
This validates all source files and packages the plugin directly into:
`dist/orcid-assistant.xpi`

### Run Automated Tests
```bash
npm test
```
The test suite performs 33 automated checks:
1. Source file integrity and presence.
2. `manifest.json` schema validation (`manifest_version: 2`, application IDs, version bounds).
3. ECMAScript syntax analysis of `bootstrap.js` and `orcid-assistant.js` via Node.js VM.
4. Simulated lifecycle testing (startup, menu registration, command dispatch, dialog invocation).
5. Clean shutdown verification (DOM element removal, hook unregistration, memory cleanup).
6. `.xpi` package verification (correct ZIP structure with `manifest.json` and `bootstrap.js` at root).

---

## 4. Manual Installation in Zotero

1. Open Zotero.
2. In the top menubar, navigate to **Tools** → **Plugins** (or **Tools** → **Add-ons**).
3. Click the gear icon (⚙️) located in the upper-right corner of the Add-ons Manager window.
4. Select **"Install Add-on From File..."**.
5. Browse to the project folder and select:
   ```
   dist/orcid-assistant.xpi
   ```
6. Click **Install** when prompted. The plugin will activate immediately without restarting Zotero.

---

## 5. Verifying Functionality & Lifecycle

### Step 5.1: Menu Interaction
* Click **Tools** in the top menubar.
* You will see the new menu item: **ORCID Assistant**.
* Click **ORCID Assistant**.
* A modal dialog will appear with the message:
  > **ORCID Assistant is running.**
* Click **OK** to dismiss the dialog.

### Step 5.2: Disable & Cleanup Verification
* Open **Tools** → **Plugins**.
* Locate **ORCID Assistant** and toggle the switch to **Disabled**.
* Open the **Tools** menu: the **ORCID Assistant** item is cleanly removed.
* Toggle the switch back to **Enabled**: the menu item immediately re-appears.

### Step 5.3: Application Restart
* Close Zotero completely and reopen it.
* Verify that the **Tools** → **ORCID Assistant** entry remains intact and functional.
* Check Zotero debug logs under **Help** → **Debug Output Logging** → **View Output** for `ORCID Assistant: ...` initialization entries.

---

## 6. Safety & Non-Interference Guarantees
* **No Database Mutation**: Does not alter SQLite tables or bibliographic records.
* **No External Network Calls**: Does not query the ORCID API or send telemetry.
* **No Zotero Core Modifications**: Fully contained within the independent `.xpi` add-on.
* **Clean Unload**: Zero residual DOM elements or memory leaks upon disable or uninstall.

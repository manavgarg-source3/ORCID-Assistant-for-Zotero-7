# ORCID Assistant for Zotero 7+

**ORCID Assistant** is an open-source Zotero desktop plugin designed to streamline importing, verifying, and linking researcher publication records with [ORCID](https://orcid.org).

> **Step 2 Implementation Status:** Built upon the verified Step 1 lifecycle foundation. Adds a local-only Node.js helper service that securely brokers ORCID Public API requests using credentials in a git-ignored `.env` file, an interactive ORCID iD input prompt in Zotero, client-side ISO 7064 MOD 11-2 validation, and a read-only works preview dialog displaying titles, DOIs, publication years, and total work counts.
>
> **Strict Read-Only Guarantee:** No items are imported, created, updated, or deleted in the Zotero SQLite library. No automatic sync or write scopes are used.

---

## 1. Architecture & Design

```mermaid
flowchart LR
    subgraph Zotero["Zotero Desktop (10.0.6 / 7+)"]
        Menu["Tools -> ORCID Assistant"] --> Input["ORCID iD Prompt\n(Client-side ISO 7064 Check)"]
        Input --> FetchAction["Fetch Works Action\n(GET /api/works)"]
        Preview["Read-Only Preview Dialog\n(Title, DOI, Year, Count)"] <-- FetchAction
    end

    subgraph Localhost["Local Workstation (127.0.0.1 only)"]
        Helper["Helper Service :23125\n(Node.js HTTP Server)"]
        Env[".env (Ignored by git)\nORCID_CLIENT_ID\nORCID_CLIENT_SECRET"] --> Helper
    end

    subgraph ORCID["ORCID Registry"]
        OAuth["POST /oauth/token\n(grant_type=client_credentials\nscope=/read-public)"]
        API["GET /v3.0/{orcid}/works\n(Official ORCID API)"]
    end

    FetchAction -- "HTTP (Localhost Only)" --> Helper
    Helper -- "2-Legged OAuth" --> OAuth
    Helper -- "Bearer Token Query" --> API
```

### Components

* **`src/manifest.json`**: WebExtension manifest (`manifest_version: 2`) configured with `applications.zotero` (`strict_min_version: "7.0"`, `strict_max_version: "10.0.*"`, and `update_url`).
* **`src/bootstrap.js`**: Gecko restartless lifecycle hooks (`startup`, `shutdown`, `onMainWindowLoad`, etc.).
* **`src/orcid-assistant.js`**: Core plugin logic. Manages `Zotero.MenuManager` integration, input dialogs, client-side ORCID normalization/checksum verification, local helper communication, and read-only preview rendering.
* **`helper-service/server.js`**: Localhost-only HTTP server bound strictly to `127.0.0.1:23125`. Exposes `/health` and `/api/works` endpoints. Never logs or leaks secrets.
* **`helper-service/orcid-client.js`**: 2-legged OAuth token management (in-memory TTL cache) and ORCID v3.0 works parser.
* **`.env.example`**: Safe configuration template for local development credentials.
* **`scripts/build.js`**: Packages only `src/` into `dist/orcid-assistant.xpi` (strictly isolates `.env` and `helper-service/`).
* **`scripts/test.js`**: Automated plugin tests (76 passing assertions).
* **`helper-service/test.js`**: Automated helper service tests (31 passing assertions).

---

## 2. Security & Credentials Isolation

To protect API credentials while complying with open-source guidelines:
1. **Never Packaged in XPI**: The packaging pipeline (`scripts/build.js`) exclusively copies files from `src/`. Neither `.env` nor `helper-service/` are ever packaged into `dist/orcid-assistant.xpi`.
2. **Never Committed to Git**: `.env`, `.env.local`, and `.env.*.local` are explicitly excluded in `.gitignore`.
3. **Bound to Localhost Only**: The helper service strictly binds to IP `127.0.0.1` (not `0.0.0.0`), preventing unauthorized access from the local network.
4. **Sanitized Error Responses**: Token requests and error messages are filtered so that access tokens and client secrets are never printed to terminal logs or returned over HTTP.

---

## 3. Safe Local Setup Instructions

### Prerequisites
* **Node.js**: v18+ (tested on Node v24.18.0)
* **Zotero Desktop**: Zotero 7.0+ or Zotero 10.0.6
* **ORCID Public API Credentials**: Register a free account at [orcid.org/developer-tools](https://orcid.org/developer-tools) to obtain a Client ID and Client Secret.

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Configure Local Environment
Copy the example environment file:
```bash
cp .env.example .env
```
*(On Windows PowerShell: `Copy-Item .env.example .env`)*

Edit `.env` with your ORCID Public API credentials:
```env
PORT=23125
HOST=127.0.0.1
ORCID_CLIENT_ID=APP-XXXXXXXXXXXXXXXX
ORCID_CLIENT_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### Step 3: Start the Local Helper Service
In a terminal window:
```bash
npm run helper
```
Output:
```
[Helper] Loading environment from: .../.env
[Helper] Service running on http://127.0.0.1:23125
[Helper] Security notice: Bound to localhost only.
```

### Step 4: Build and Verify Plugin Package
In a second terminal window:
```bash
npm run package
```
This builds `dist/orcid-assistant.xpi` and runs the full automated test suite (107 checks across plugin and helper).

---

## 4. Manual Installation in Zotero

1. Open Zotero.
2. In the top menubar, navigate to **Tools** → **Plugins** (or **Tools** → **Add-ons**).
3. Click the gear icon (⚙️) located in the upper-right corner.
4. Select **"Install Add-on From File..."**.
5. Select `dist/orcid-assistant.xpi` from this project folder.
6. Click **Install**. The add-on activates immediately without restarting.

---

## 5. Testing the Step 2 Preview Feature

### Step 5.1: Trigger Public Works Fetch
1. In Zotero, click **Tools** → **ORCID Assistant**.
2. An input dialog appears with the prompt:
   > *ORCID Assistant is running.*
   > *Enter an ORCID iD to preview public works:*
3. Enter a valid ORCID identifier (e.g., `0000-0002-1825-0097` or `https://orcid.org/0000-0002-1825-0097`).
4. Click **OK**.

### Step 5.2: Inspect Read-Only Preview
A dialog opens displaying the fetched results:
```text
ORCID Public Works Preview (2 works found)
==================================================
ORCID iD:    0000-0002-1825-0097
Total Works: 2
--------------------------------------------------
[1] Title: Example Research Paper Title
    Year:  2023
    DOI:   10.1000/182
    Type:  journal-article

[2] Title: Another Open Access Publication
    Year:  2021
    DOI:   None
    Type:  book-chapter
==================================================
READ-ONLY PREVIEW: No items were imported, modified,
or deleted in your Zotero library.
==================================================
```
5. Click **OK**. A follow-up prompt will ask:
   > *Would you like to fetch public works for another ORCID iD?*
6. Select **Cancel** to close or **OK** to enter another identifier.

### Step 5.3: Error Handling Verification
* **Helper Offline**: Stop the helper service and click **Tools** → **ORCID Assistant**. A dialog informs you: *"Could not connect to helper service at http://127.0.0.1:23125. Please run npm run helper"*.
* **Invalid Format / Checksum**: Enter `0000-0002-1825-0098` (corrupt check digit). The plugin catches the error client-side without network calls and offers a correction prompt.
* **Missing Credentials**: Remove credentials from `.env`. The helper informs you with clear setup instructions.
* **Non-existent Profile**: Enter a validly formatted but non-existent ORCID. The dialog reports a clean 404 record-not-found message.

---

## 6. Automated Test Suite (107 Passing Tests)

Run all tests:
```bash
npm test
```

### Plugin Verification (`scripts/test.js` - 76 Tests)
* Manifest v2 compatibility and strict version bounds (`7.0` - `10.0.*`).
* Syntax parsing in Node.js VM.
* Gecko lifecycle (`startup`, `shutdown`, `onMainWindowLoad`, `onMainWindowUnload`).
* Step 1 dialog preservation (`ORCID Assistant is running.`).
* Client-side ISO 7064 MOD 11-2 checksum & format validator (valid, URL prefixes, lowercase x, invalid check digit, empty).
* Read-only preview text formatter (titles, DOIs, years, work count, disclaimer).
* Helper client with mocked responses (success, empty works, missing credentials, 404, network offline, timeout).
* Interactive prompt UI flow simulation.
* Strict read-only verification (zero calls to `Zotero.Items` or item write methods).
* Security isolation check (verifies `.env` and `helper-service/` are never in `.xpi`).

### Helper Service Verification (`helper-service/test.js` - 31 Tests)
* ISO 7064 check digit validation unit tests.
* Credential missing detection and error sanitization.
* Mocked 2-legged OAuth token acquisition (`/read-public`) and in-memory TTL caching.
* Mocked ORCID API v3.0 works XML/JSON parsing.
* Error handling for 404 and empty profiles.
* Live HTTP server endpoint tests on an ephemeral port (`GET /health`, `GET /api/works`).

---

## 7. Safety & Non-Interference Guarantees
* **No Database Mutation**: Does not alter SQLite tables or create/edit/delete bibliographic records.
* **No Automatic Sync**: Does not write to ORCID or schedule background synchronizations.
* **Zero Zotero Core Modifications**: Completely contained within the independent `.xpi` add-on.
* **Localhost-Only Networking**: The helper service communicates with ORCID on your behalf and exposes only `127.0.0.1` locally.

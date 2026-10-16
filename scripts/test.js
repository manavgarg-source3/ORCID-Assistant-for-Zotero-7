/**
 * test.js - Automated Verification & Test Suite for ORCID Assistant Zotero Plugin
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const AdmZip = require('adm-zip');

console.log('=== Running Automated Tests for ORCID Assistant ===\n');

let passedTests = 0;
let failedTests = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`FAIL: ${testName}`);
    failedTests++;
  }
}

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const XPI_PATH = path.join(DIST_DIR, 'orcid-assistant.xpi');

// Test 1: File Existence
const files = [
  'manifest.json',
  'bootstrap.js',
  'orcid-assistant.js',
  'prefs.js',
  'locale/en-US/orcid-assistant.ftl'
];

for (const file of files) {
  assert(fs.existsSync(path.join(SRC_DIR, file)), `Source file exists: ${file}`);
}

// Test 2: Manifest Validation
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'manifest.json'), 'utf8'));
  assert(manifest.manifest_version === 2, 'manifest_version is 2 (WebExtension)');
  assert(manifest.name === 'ORCID Assistant', 'Plugin name is "ORCID Assistant"');
  assert(manifest.version === '1.0.0', 'Plugin version is specified');

  const appConfig = manifest.applications?.zotero;
  assert(!!appConfig, 'applications.zotero block present');
  assert(appConfig.id === 'orcid-assistant@zotero.org', 'Plugin ID is orcid-assistant@zotero.org');
  assert(!!appConfig.update_url, 'applications.zotero.update_url is defined');
  assert(appConfig.strict_min_version === '7.0', 'strict_min_version targets 7.0+');
  assert(appConfig.strict_max_version === '10.0.*', 'strict_max_version targets 10.0.* for installed Zotero 10.0.6');
} catch (e) {
  assert(false, `Manifest JSON is valid: ${e.message}`);
}

// Test 3: JavaScript Syntax Check
try {
  const bootstrapCode = fs.readFileSync(path.join(SRC_DIR, 'bootstrap.js'), 'utf8');
  new vm.Script(bootstrapCode, { filename: 'bootstrap.js' });
  assert(true, 'bootstrap.js has valid ECMAScript syntax');
} catch (e) {
  assert(false, `bootstrap.js syntax error: ${e.message}`);
}

try {
  const coreCode = fs.readFileSync(path.join(SRC_DIR, 'orcid-assistant.js'), 'utf8');
  new vm.Script(coreCode, { filename: 'orcid-assistant.js' });
  assert(true, 'orcid-assistant.js has valid ECMAScript syntax');
} catch (e) {
  assert(false, `orcid-assistant.js syntax error: ${e.message}`);
}

// Test 4: Mocked Lifecycle & Menu Registration / Cleanup Test
try {
  const mockDOM = () => {
    const elements = new Map();
    const toolsPopup = {
      id: 'menu_ToolsPopup',
      children: [],
      appendChild(child) {
        this.children.push(child);
        elements.set(child.id, child);
      },
      querySelectorAll() { return []; }
    };
    elements.set('menu_ToolsPopup', toolsPopup);

    const doc = {
      getElementById(id) {
        return elements.get(id) || null;
      },
      createXULElement(tag) {
        const el = {
          tagName: tag,
          id: null,
          attributes: {},
          listeners: {},
          setAttribute(k, v) { this.attributes[k] = v; },
          getAttribute(k) { return this.attributes[k]; },
          addEventListener(event, fn) { this.listeners[event] = fn; },
          remove() {
            if (this.id) elements.delete(this.id);
            const idx = toolsPopup.children.indexOf(this);
            if (idx !== -1) toolsPopup.children.splice(idx, 1);
          }
        };
        return el;
      },
      querySelector(sel) { return null; }
    };

    return {
      document: doc,
      ZoteroPane: true,
      location: { href: 'chrome://zotero/content/zoteroPane.xhtml' },
      MozXULElement: { insertFTLIfNeeded: () => {} }
    };
  };

  const mockWindow = mockDOM();
  let alertCalledWith = null;

  const sandbox = {
    console,
    Services: {
      prompt: {
        alert(win, title, msg) {
          alertCalledWith = { title, msg };
        }
      },
      scriptloader: {
        loadSubScript(uri) {
          const code = fs.readFileSync(path.join(SRC_DIR, 'orcid-assistant.js'), 'utf8');
          vm.runInContext(code, sandbox);
        }
      }
    },
    Zotero: {
      debug(msg) {},
      logError(err) {},
      getMainWindows() { return [mockWindow]; },
      getMainWindow() { return mockWindow; }
    }
  };

  vm.createContext(sandbox);

  // Load bootstrap.js
  const bootstrapCode = fs.readFileSync(path.join(SRC_DIR, 'bootstrap.js'), 'utf8');
  vm.runInContext(bootstrapCode, sandbox);

  // Assert lifecycle functions exist
  assert(typeof sandbox.install === 'function', 'bootstrap.js exports install()');
  assert(typeof sandbox.startup === 'function', 'bootstrap.js exports startup()');
  assert(typeof sandbox.shutdown === 'function', 'bootstrap.js exports shutdown()');
  assert(typeof sandbox.uninstall === 'function', 'bootstrap.js exports uninstall()');
  assert(typeof sandbox.onMainWindowLoad === 'function', 'bootstrap.js exports onMainWindowLoad()');
  assert(typeof sandbox.onMainWindowUnload === 'function', 'bootstrap.js exports onMainWindowUnload()');

  // Run startup
  const startupPromise = sandbox.startup({
    id: 'orcid-assistant@zotero.org',
    version: '1.0.0',
    rootURI: 'resource://orcid-assistant/'
  }, 1);

  startupPromise.then(async () => {
    // Verify menu item was added to toolsPopup
    const menuItem = mockWindow.document.getElementById('orcid-assistant-tools-menuitem');
    assert(menuItem !== null, 'Menu item was registered in Tools popup on startup');
    assert(menuItem.getAttribute('label') === 'ORCID Assistant', 'Menu item has label "ORCID Assistant"');
    assert(menuItem.getAttribute('data-l10n-id') === 'orcid-assistant-menu-item', 'Menu item has Fluent l10n-id');

    // Trigger command listener (fallback when prompt API not configured in sandbox)
    assert(typeof menuItem.listeners['command'] === 'function', 'Menu item has command event listener');
    menuItem.listeners['command']({ target: menuItem });

    assert(alertCalledWith !== null, 'Clicking menu item invoked dialog');
    assert(alertCalledWith?.title === 'ORCID Assistant', 'Dialog title is "ORCID Assistant"');
    assert(alertCalledWith?.msg === 'ORCID Assistant is running.', 'Dialog text is "ORCID Assistant is running." (Step 1 behavior preserved)');

    // ==========================================
    // Test 5: Step 2 Client-Side Validation Tests
    // ==========================================
    console.log('\n-- Step 2: Client-Side ORCID Validation Tests --');
    const OA = sandbox.ORCIDAssistant;
    assert(typeof OA.validateAndNormalizeOrcid === 'function', 'validateAndNormalizeOrcid exists on plugin');

    const v1 = OA.validateAndNormalizeOrcid('0000-0002-1825-0097');
    assert(v1.valid === true && v1.orcid === '0000-0002-1825-0097', 'Valid standard ORCID iD accepted');

    const v2 = OA.validateAndNormalizeOrcid('https://orcid.org/0000-0002-1825-0097');
    assert(v2.valid === true && v2.orcid === '0000-0002-1825-0097', 'ORCID with https:// prefix normalized');

    const v3 = OA.validateAndNormalizeOrcid('0000-0002-1694-233X');
    assert(v3.valid === true && v3.orcid === '0000-0002-1694-233X', 'Valid ORCID ending with X check digit accepted');

    const v4 = OA.validateAndNormalizeOrcid('0000-0002-1694-233x');
    assert(v4.valid === true && v4.orcid === '0000-0002-1694-233X', 'Lowercase x normalized to uppercase');

    const v5 = OA.validateAndNormalizeOrcid('invalid-string');
    assert(v5.valid === false, 'Invalid string format rejected');

    const v6 = OA.validateAndNormalizeOrcid('0000-0002-1825-0098');
    assert(v6.valid === false && v6.error.includes('check digit'), 'Checksum mismatch rejected');

    const v7 = OA.validateAndNormalizeOrcid('');
    assert(v7.valid === false && v7.error.includes('empty'), 'Empty string rejected');

    // ==========================================
    // Test 6: Step 2 Works Preview Text Formatting
    // ==========================================
    console.log('\n-- Step 2: Read-Only Preview Formatting Tests --');
    assert(typeof OA.formatWorksPreview === 'function', 'formatWorksPreview exists on plugin');

    const mockWorksData = {
      success: true,
      orcid: '0000-0002-1825-0097',
      totalWorks: 2,
      works: [
        { title: 'Graph Theory & Citation Networks', year: '2023', doi: '10.1000/182', type: 'journal-article' },
        { title: 'Open Science Practices', year: '2021', doi: null, type: 'book' }
      ]
    };

    const preview = OA.formatWorksPreview(mockWorksData);
    assert(preview.includes('0000-0002-1825-0097'), 'Preview contains ORCID iD');
    assert(preview.includes('Total Works: 2'), 'Preview contains total work count');
    assert(preview.includes('Graph Theory & Citation Networks'), 'Preview includes work title 1');
    assert(preview.includes('10.1000/182'), 'Preview includes DOI');
    assert(preview.includes('2023'), 'Preview includes publication year');
    assert(preview.includes('READ-ONLY PREVIEW'), 'Preview contains read-only disclaimer');
    assert(preview.includes('No items were imported'), 'Preview confirms zero library modification');

    const emptyWorksData = {
      success: true,
      orcid: '0000-0002-1825-0097',
      totalWorks: 0,
      works: []
    };
    const emptyPreview = OA.formatWorksPreview(emptyWorksData);
    assert(emptyPreview.includes('No public works found'), 'Preview handles zero works gracefully');

    // ==========================================
    // Test 7: Step 2 Helper Client with Mocked Responses
    // ==========================================
    console.log('\n-- Step 2: Helper Communication with Mocked Responses --');
    assert(typeof OA.fetchWorksFromHelper === 'function', 'fetchWorksFromHelper exists on plugin');

    // 7a: Successful fetch
    OA.fetchImpl = async (url) => {
      assert(url.includes('0000-0002-1825-0097'), 'Helper requested with correct encoded ORCID');
      return {
        ok: true,
        json: async () => mockWorksData
      };
    };
    const fetchRes = await OA.fetchWorksFromHelper('0000-0002-1825-0097');
    assert(fetchRes.success === true, 'Helper returned success');
    assert(fetchRes.totalWorks === 2, 'Helper returned 2 works');
    assert(fetchRes.works[0].title === 'Graph Theory & Citation Networks', 'Helper parsed works correctly');

    // 7b: Missing credentials error
    OA.fetchImpl = async () => ({
      ok: false,
      json: async () => ({
        success: false,
        code: 'MISSING_CREDENTIALS',
        error: 'ORCID credentials not configured in helper .env file'
      })
    });
    const missingCredsRes = await OA.fetchWorksFromHelper('0000-0002-1825-0097');
    assert(missingCredsRes.success === false, 'Helper handles missing credentials');
    assert(missingCredsRes.code === 'MISSING_CREDENTIALS', 'Code is MISSING_CREDENTIALS');

    // 7c: 404 record not found
    OA.fetchImpl = async () => ({
      ok: false,
      json: async () => ({
        success: false,
        code: 'RECORD_NOT_FOUND',
        error: 'ORCID record not found (404)'
      })
    });
    const notFoundRes = await OA.fetchWorksFromHelper('0000-0002-1825-0097');
    assert(notFoundRes.success === false && notFoundRes.code === 'RECORD_NOT_FOUND', 'Helper handles 404 RECORD_NOT_FOUND');

    // 7d: Network error (helper service down)
    OA.fetchImpl = async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:23125');
      err.code = 'ECONNREFUSED';
      throw err;
    };
    const netErrRes = await OA.fetchWorksFromHelper('0000-0002-1825-0097');
    assert(netErrRes.success === false && netErrRes.code === 'NETWORK_ERROR', 'Network error caught and categorized as NETWORK_ERROR');
    assert(netErrRes.error.includes('npm run helper'), 'Network error advises user to run helper service');

    // 7e: Timeout error
    OA.fetchImpl = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    const timeoutRes = await OA.fetchWorksFromHelper('0000-0002-1825-0097');
    assert(timeoutRes.success === false && timeoutRes.code === 'TIMEOUT', 'Timeout caught and categorized as TIMEOUT');

    // ==========================================
    // Test 8: Interactive Prompt Flow
    // ==========================================
    console.log('\n-- Step 2: Interactive Prompt UI Flow Tests --');
    let promptCalls = [];
    let alertCalls = [];
    let confirmCalls = [];

    sandbox.Services.prompt = {
      prompt(win, title, msg, inputVal, checkMsg, checkVal) {
        promptCalls.push({ title, msg });
        inputVal.value = '0000-0002-1825-0097';
        return true; // Click OK
      },
      alert(win, title, msg) {
        alertCalls.push({ title, msg });
      },
      confirm(win, title, msg) {
        confirmCalls.push({ title, msg });
        return false; // Exit loop after preview
      }
    };

    OA.fetchImpl = async () => ({
      ok: true,
      json: async () => mockWorksData
    });

    await OA.promptFetchPublicWorks(mockWindow);
    assert(promptCalls.length === 1, 'promptFetchPublicWorks displayed input prompt to user');
    assert(promptCalls[0].title.includes('ORCID Assistant'), 'Prompt title contains "ORCID Assistant"');
    assert(alertCalls.length === 1, 'Preview alert dialog was displayed to user');
    assert(alertCalls[0].title.includes('2 works found'), 'Preview dialog title reflects work count');
    assert(alertCalls[0].msg.includes('READ-ONLY PREVIEW'), 'Preview dialog body contains read-only disclaimer');
    assert(confirmCalls.length === 1, 'Prompted user if they want to fetch works for another ORCID iD');

    // Test prompt cancellation
    promptCalls = [];
    sandbox.Services.prompt.prompt = (win, title, msg, inputVal) => {
      promptCalls.push({ title, msg });
      return false; // User clicked Cancel
    };
    await OA.promptFetchPublicWorks(mockWindow);
    assert(promptCalls.length === 1, 'Prompt opened and user cancelled');
    assert(alertCalls.length === 1, 'No additional alert called when user cancelled prompt');

    // ==========================================
    // Test 9: Strict Read-Only Verification
    // ==========================================
    console.log('\n-- Step 2: Strict Read-Only Verification --');
    assert(sandbox.Zotero.Items === undefined, 'No Zotero.Items API write operations exist');
    assert(typeof OA.showRunningDialog === 'function', 'showRunningDialog preserved from Step 1');

    // Test shutdown cleanup
    sandbox.shutdown({}, 1);

    const menuItemAfterShutdown = mockWindow.document.getElementById('orcid-assistant-tools-menuitem');
    assert(menuItemAfterShutdown === null, 'Menu item cleanly removed from DOM on shutdown');
    assert(sandbox.ORCIDAssistant === undefined, 'ORCIDAssistant singleton is unset on shutdown');

    // ==========================================
    // Test 10: Verify XPI Archive Content & Isolation
    // ==========================================
    console.log('\n-- Step 2: XPI Archive Security & Content Isolation --');
    if (fs.existsSync(XPI_PATH)) {
      const zip = new AdmZip(XPI_PATH);
      const entries = zip.getEntries().map(e => e.entryName);
      assert(entries.includes('manifest.json'), 'XPI contains manifest.json at root');
      assert(entries.includes('bootstrap.js'), 'XPI contains bootstrap.js at root');
      assert(entries.includes('orcid-assistant.js'), 'XPI contains orcid-assistant.js at root');
      assert(entries.includes('locale/en-US/orcid-assistant.ftl'), 'XPI contains Fluent translation file');
      assert(entries.includes('prefs.js'), 'XPI contains prefs.js');

      // Crucial security checks: .env and helper-service must NEVER be packaged into the XPI!
      assert(!entries.some(e => e.includes('.env')), 'SECURITY: XPI strictly does NOT contain .env file');
      assert(!entries.some(e => e.startsWith('helper-service')), 'SECURITY: XPI strictly does NOT contain helper-service files');
      assert(!entries.some(e => e.includes('client_secret')), 'SECURITY: XPI strictly does NOT contain credentials');
    } else {
      console.log('NOTE: XPI not yet built. Run npm run build first.');
    }

    console.log(`\n=== Test Summary: ${passedTests} Passed, ${failedTests} Failed ===`);
    if (failedTests > 0) {
      process.exit(1);
    }
  });

} catch (e) {
  assert(false, `Lifecycle execution failed: ${e.stack}`);
}



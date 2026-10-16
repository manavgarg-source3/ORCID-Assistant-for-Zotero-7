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

  startupPromise.then(() => {
    // Verify menu item was added to toolsPopup
    const menuItem = mockWindow.document.getElementById('orcid-assistant-tools-menuitem');
    assert(menuItem !== null, 'Menu item was registered in Tools popup on startup');
    assert(menuItem.getAttribute('label') === 'ORCID Assistant', 'Menu item has label "ORCID Assistant"');
    assert(menuItem.getAttribute('data-l10n-id') === 'orcid-assistant-menu-item', 'Menu item has Fluent l10n-id');

    // Trigger command listener
    assert(typeof menuItem.listeners['command'] === 'function', 'Menu item has command event listener');
    menuItem.listeners['command']({ target: menuItem });

    assert(alertCalledWith !== null, 'Clicking menu item invoked dialog');
    assert(alertCalledWith?.title === 'ORCID Assistant', 'Dialog title is "ORCID Assistant"');
    assert(alertCalledWith?.msg === 'ORCID Assistant is running.', 'Dialog text is "ORCID Assistant is running."');

    // Test shutdown cleanup
    sandbox.shutdown({}, 1);

    const menuItemAfterShutdown = mockWindow.document.getElementById('orcid-assistant-tools-menuitem');
    assert(menuItemAfterShutdown === null, 'Menu item cleanly removed from DOM on shutdown');
    assert(sandbox.ORCIDAssistant === undefined, 'ORCIDAssistant singleton is unset on shutdown');

    // Test 5: Verify XPI Package
    if (fs.existsSync(XPI_PATH)) {
      const zip = new AdmZip(XPI_PATH);
      const entries = zip.getEntries().map(e => e.entryName);
      assert(entries.includes('manifest.json'), 'XPI contains manifest.json at root');
      assert(entries.includes('bootstrap.js'), 'XPI contains bootstrap.js at root');
      assert(entries.includes('orcid-assistant.js'), 'XPI contains orcid-assistant.js at root');
      assert(entries.includes('locale/en-US/orcid-assistant.ftl'), 'XPI contains Fluent translation file');
      assert(entries.includes('prefs.js'), 'XPI contains prefs.js');
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


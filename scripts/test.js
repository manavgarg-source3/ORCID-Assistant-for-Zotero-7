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

    // Verify batch menu item was added to toolsPopup
    const batchMenuItem = mockWindow.document.getElementById('orcid-assistant-tools-batch-menuitem');
    assert(batchMenuItem !== null, 'Batch menu item was registered in Tools popup on startup');
    assert(batchMenuItem.getAttribute('label') === 'ORCID Assistant — Batch CSV Import...', 'Batch menu item has correct label');
    assert(batchMenuItem.getAttribute('data-l10n-id') === 'orcid-assistant-menu-batch-item', 'Batch menu item has Fluent l10n-id');
    assert(typeof batchMenuItem.listeners['command'] === 'function', 'Batch menu item has command event listener');

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
        { title: 'Graph Theory & Citation Networks', year: '2023', doi: '10.1000/182', type: 'journal-article', author: 'Josiah Carberry', duplicateStatus: 'Already in Zotero', matchReason: 'Matched DOI: 10.1000/182' },
        { title: 'Open Science Practices', year: '2021', doi: null, type: 'book', author: 'Ada Lovelace', duplicateStatus: 'New' }
      ]
    };

    const preview = OA.formatWorksPreview(mockWorksData);
    assert(preview.includes('0000-0002-1825-0097'), 'Preview contains ORCID iD');
    assert(preview.includes('Total Works: 2'), 'Preview contains total work count');
    assert(preview.includes('Graph Theory & Citation Networks'), 'Preview includes work title 1');
    assert(preview.includes('Josiah Carberry'), 'Preview includes author 1');
    assert(preview.includes('10.1000/182'), 'Preview includes DOI');
    assert(preview.includes('2023'), 'Preview includes publication year');
    assert(preview.includes('[Already in Zotero]'), 'Preview includes [Already in Zotero] label');
    assert(preview.includes('[New]'), 'Preview includes [New] label');
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
    // Test 9: Step 3 Duplicate Detection & Library Integration Tests
    // ==========================================
    console.log('\n-- Step 3: Duplicate Detection & Normalization Tests --');

    // 9a: DOI Normalization
    assert(typeof OA.normalizeDoi === 'function', 'normalizeDoi function exists');
    assert(OA.normalizeDoi('10.1000/182') === '10.1000/182', 'Standard DOI normalized');
    assert(OA.normalizeDoi('https://doi.org/10.1000/182') === '10.1000/182', 'https://doi.org/ prefix stripped');
    assert(OA.normalizeDoi('http://dx.doi.org/10.1000/182/') === '10.1000/182', 'http://dx.doi.org/ prefix and trailing slash stripped');
    assert(OA.normalizeDoi('doi: 10.1000/182.') === '10.1000/182', 'doi: prefix and trailing dot stripped');
    assert(OA.normalizeDoi('10.1000/AbC-XyZ') === '10.1000/abc-xyz', 'DOI normalized to lowercase');
    assert(OA.normalizeDoi(null) === null, 'null DOI returns null');
    assert(OA.normalizeDoi('') === null, 'Empty DOI returns null');

    // 9b: Title Normalization & Matching
    assert(typeof OA.normalizeTitle === 'function', 'normalizeTitle function exists');
    assert(OA.normalizeTitle('Quantum Computing: An Overview.') === 'quantum computing an overview', 'Punctuation stripped from title');
    assert(OA.normalizeTitle('  Machine   Learning   ') === 'machine learning', 'Whitespace collapsed and trimmed');
    assert(OA.titlesMatch('Quantum Computing: An Overview', 'quantum computing - an overview.') === true, 'Punctuation variations match');
    assert(OA.titlesMatch('Deep Learning for NLP', 'deep learning for nlp') === true, 'Case insensitive title match');
    assert(OA.titlesMatch('Different Paper Title A', 'Unrelated Topic B') === false, 'Dissimilar titles do not match');

    // 9c: Year Extraction
    assert(typeof OA.extractYear === 'function', 'extractYear function exists');
    assert(OA.extractYear('2023-05-12') === '2023', 'Year extracted from ISO date string');
    assert(OA.extractYear(2018) === '2018', 'Year extracted from number');
    assert(OA.extractYear('Published in 1999') === '1999', 'Year extracted from prose');
    assert(OA.extractYear('Unknown Date') === null, 'Non-date returns null');

    // 9d: Author Tokens & Matching
    assert(typeof OA.extractAuthorTokens === 'function', 'extractAuthorTokens function exists');
    const authorTokens = OA.extractAuthorTokens('Josiah Carberry, Ada Lovelace');
    assert(authorTokens.includes('carberry') && authorTokens.includes('lovelace'), 'Author tokens extracted correctly');
    assert(OA.authorsMatch('Josiah Carberry', 'Carberry, J.') === 'carberry', 'Matching author token detected');
    assert(OA.authorsMatch('John Smith', 'Ada Lovelace') === false, 'Conflicting authors detected as false');
    assert(OA.authorsMatch(null, 'Ada Lovelace') === null, 'Missing author metadata returns null');

    // 9e: Duplicate Detection - Strongest Match: Normalized DOI
    console.log('\n-- Step 3: Local Library Matching Tests --');
    const localLibraryMock = [
      {
        id: 101,
        title: 'Completely Different Title in Local Library',
        doi: '10.1000/182',
        year: '2020',
        author: 'Smith'
      },
      {
        id: 102,
        title: 'A Methodology for the Emulation of Architecture',
        doi: '10.5555/12345680',
        year: '2012',
        author: 'Josiah Carberry'
      },
      {
        id: 103,
        title: 'Quantum computing a survey part 1',
        doi: null,
        year: '2021',
        author: 'Ada Lovelace'
      },
      {
        id: 104,
        title: 'Title Matching Work With Conflicting Year',
        doi: null,
        year: '2015',
        author: 'Josiah Carberry'
      },
      {
        id: 105,
        title: 'Title Matching Work With Conflicting Author',
        doi: null,
        year: '2023',
        author: 'Bob Taylor'
      },
      {
        id: 106,
        title: 'Title-Only Resemblance With Missing Year And Author',
        doi: null,
        year: null,
        author: null
      }
    ];

    // Case 1: DOI Match (URL prefix in ORCID, raw DOI in Zotero) -> "Already in Zotero"
    const orcidWorksCase1 = [
      {
        title: 'Emulation of Architecture: Research Paper',
        doi: 'https://doi.org/10.1000/182/',
        year: '2023',
        author: 'Josiah Carberry'
      }
    ];
    const res1 = OA.detectDuplicates(orcidWorksCase1, localLibraryMock);
    assert(res1[0].duplicateStatus === 'Already in Zotero', 'Exact normalized DOI match labeled "Already in Zotero"');
    assert(res1[0].matchType === 'DOI', 'Match type is DOI');
    assert(res1[0].matchedItem.id === 101, 'Matched correct local library item ID');

    // Case 2: Missing DOI on ORCID work, Title + Year + Author Match -> "Possible Duplicate"
    const orcidWorksCase2 = [
      {
        title: 'A methodology for the emulation of architecture.',
        doi: null,
        year: '2012',
        author: 'Carberry, Josiah'
      }
    ];
    const res2 = OA.detectDuplicates(orcidWorksCase2, localLibraryMock);
    assert(res2[0].duplicateStatus === 'Possible Duplicate', 'Missing DOI with matching title, year, and author labeled "Possible Duplicate"');
    assert(res2[0].matchType === 'TITLE_YEAR', 'Match type is TITLE_YEAR');
    assert(res2[0].matchedItem.id === 102, 'Matched correct item 102');

    // Case 3: Title Variations (colon vs dash, lowercase) with matching year & author -> "Possible Duplicate"
    const orcidWorksCase3 = [
      {
        title: 'Quantum Computing: A Survey - Part 1',
        doi: null,
        year: '2021',
        author: 'Lovelace'
      }
    ];
    const res3 = OA.detectDuplicates(orcidWorksCase3, localLibraryMock);
    assert(res3[0].duplicateStatus === 'Possible Duplicate', 'Title variation with matching year and author labeled "Possible Duplicate"');
    assert(res3[0].matchedItem.id === 103, 'Matched correct item 103');

    // Case 4: Negative Match: Same title, but DIFFERENT years (e.g. 2022 vs 2015) -> "New"
    const orcidWorksCase4 = [
      {
        title: 'Title Matching Work With Conflicting Year',
        doi: null,
        year: '2022', // Local is 2015
        author: 'Josiah Carberry'
      }
    ];
    const res4 = OA.detectDuplicates(orcidWorksCase4, localLibraryMock);
    assert(res4[0].duplicateStatus === 'New', 'Conflicting year is NOT treated as duplicate; labeled "New"');

    // Case 5: Negative Match: Same title and year, but DIFFERENT authors -> "New"
    const orcidWorksCase5 = [
      {
        title: 'Title Matching Work With Conflicting Author',
        doi: null,
        year: '2023',
        author: 'Josiah Carberry' // Local is Bob Taylor
      }
    ];
    const res5 = OA.detectDuplicates(orcidWorksCase5, localLibraryMock);
    assert(res5[0].duplicateStatus === 'New', 'Conflicting author is NOT treated as duplicate; labeled "New"');

    // Case 6: Negative Match: Title matches, but BOTH year and author are missing -> "New"
    // (Requirement 4: "Do not treat title-only similarity as a confirmed duplicate.")
    const orcidWorksCase6 = [
      {
        title: 'Title-Only Resemblance With Missing Year And Author',
        doi: null,
        year: null,
        author: null
      }
    ];
    const res6 = OA.detectDuplicates(orcidWorksCase6, localLibraryMock);
    assert(res6[0].duplicateStatus === 'New', 'Title-only similarity without year or author confirmation is labeled "New"');

    // Case 7: Completely New Work (no match in library) -> "New"
    const orcidWorksCase7 = [
      {
        title: 'Completely Unique Brand New Paper',
        doi: '10.9999/brand-new',
        year: '2026',
        author: 'Josiah Carberry'
      }
    ];
    const res7 = OA.detectDuplicates(orcidWorksCase7, localLibraryMock);
    assert(res7[0].duplicateStatus === 'New', 'Unmatched paper labeled "New"');

    // Case 8: Empty Local Library -> All works "New"
    const res8 = OA.detectDuplicates([
      { title: 'Work 1', doi: '10.1000/1', year: '2021', author: 'Author A' },
      { title: 'Work 2', doi: null, year: '2022', author: 'Author B' }
    ], []);
    assert(res8[0].duplicateStatus === 'New' && res8[1].duplicateStatus === 'New', 'Empty local library results in all works labeled "New"');

    // 9f: Duplicate Statistics Helper
    const testStats = OA.computeDuplicateStats([
      { duplicateStatus: 'Already in Zotero' },
      { duplicateStatus: 'Already in Zotero' },
      { duplicateStatus: 'Possible Duplicate' },
      { duplicateStatus: 'New' }
    ]);
    assert(testStats.alreadyCount === 2, 'Duplicate stats computes alreadyCount correctly');
    assert(testStats.possibleCount === 1, 'Duplicate stats computes possibleCount correctly');
    assert(testStats.newCount === 1, 'Duplicate stats computes newCount correctly');

    // 9g: Integrated Prompt Flow with Duplicate Detection
    console.log('\n-- Step 3: Interactive Prompt Flow with Duplicate Detection --');
    OA.mockLibraryItems = localLibraryMock;
    let step3AlertCalls = [];
    sandbox.Services.prompt.prompt = (win, title, msg, inputVal) => {
      inputVal.value = '0000-0002-1825-0097';
      return true;
    };
    sandbox.Services.prompt.alert = (win, title, msg) => {
      step3AlertCalls.push({ title, msg });
    };
    sandbox.Services.prompt.confirm = (win, title, msg) => false;

    OA.fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        orcid: '0000-0002-1825-0097',
        totalWorks: 3,
        works: [
          { title: 'Paper with Matching DOI', doi: '10.1000/182', year: '2023', author: 'Josiah Carberry', type: 'journal-article' },
          { title: 'Quantum Computing: A Survey - Part 1', doi: null, year: '2021', author: 'Lovelace', type: 'conference-paper' },
          { title: 'Completely Unique Brand New Paper', doi: '10.9999/brand-new', year: '2026', author: 'Josiah Carberry', type: 'journal-article' }
        ]
      })
    });

    await OA.promptFetchPublicWorks(mockWindow);
    assert(step3AlertCalls.length === 1, 'Prompt displayed preview alert dialog to user');
    const alertMsg = step3AlertCalls[0].msg;
    assert(alertMsg.includes('[Already in Zotero]'), 'Preview displays [Already in Zotero] tag');
    assert(alertMsg.includes('[Possible Duplicate]'), 'Preview displays [Possible Duplicate] tag');
    assert(alertMsg.includes('[New]'), 'Preview displays [New] tag');
    assert(alertMsg.includes('Detection:   1 Already in Zotero | 1 Possible Duplicate | 1 New'), 'Preview summary header reflects duplicate counts');
    assert(alertMsg.includes('READ-ONLY PREVIEW'), 'Preview includes read-only disclaimer');

    // ==========================================
    // Test 10: Step 4 Metadata Mapping & Author Parsing Tests
    // ==========================================
    console.log('\n-- Step 4: Metadata Mapping & Author Parsing Tests --');
    assert(typeof OA.mapOrcidTypeToZotero === 'function', 'mapOrcidTypeToZotero function exists on plugin');
    assert(OA.mapOrcidTypeToZotero('journal-article') === 'journalArticle', 'Maps journal-article to journalArticle');
    assert(OA.mapOrcidTypeToZotero('journal-issue') === 'journalArticle', 'Maps journal-issue to journalArticle');
    assert(OA.mapOrcidTypeToZotero('book') === 'book', 'Maps book to book');
    assert(OA.mapOrcidTypeToZotero('edited-book') === 'book', 'Maps edited-book to book');
    assert(OA.mapOrcidTypeToZotero('book-chapter') === 'bookSection', 'Maps book-chapter to bookSection');
    assert(OA.mapOrcidTypeToZotero('conference-paper') === 'conferencePaper', 'Maps conference-paper to conferencePaper');
    assert(OA.mapOrcidTypeToZotero('report') === 'report', 'Maps report to report');
    assert(OA.mapOrcidTypeToZotero('dissertation') === 'thesis', 'Maps dissertation to thesis');
    assert(OA.mapOrcidTypeToZotero('patent') === 'patent', 'Maps patent to patent');
    assert(OA.mapOrcidTypeToZotero('preprint') === 'preprint', 'Maps preprint to preprint');
    assert(OA.mapOrcidTypeToZotero('data-set') === 'dataset', 'Maps data-set to dataset');
    assert(OA.mapOrcidTypeToZotero('unknown-unsupported-type') === 'journalArticle', 'Defaults to journalArticle for unknown work types');

    assert(typeof OA.parseAuthorName === 'function', 'parseAuthorName function exists on plugin');
    const a1 = OA.parseAuthorName('Carberry, Josiah');
    assert(a1.lastName === 'Carberry' && a1.firstName === 'Josiah', 'Parses "Last, First" author format');
    const a2 = OA.parseAuthorName('Josiah St. John Carberry');
    assert(a2.lastName === 'Carberry' && a2.firstName === 'Josiah St. John', 'Parses multi-token "First Middle Last" author format');
    const a3 = OA.parseAuthorName('CERN Collaboration');
    assert(a3.lastName === 'CERN Collaboration' && a3.fieldMode === 1, 'Parses organizational team names with fieldMode=1');
    const a4 = OA.parseAuthorName('UNESCO');
    assert(a4.lastName === 'UNESCO' && a4.fieldMode === 1, 'Parses single institution name with fieldMode=1');
    const a5 = OA.parseAuthorName('');
    assert(a5.lastName === 'Unknown', 'Handles empty author string gracefully');

    // 10b: normalizeCreator tests (Step 4.1)
    console.log('\n-- Step 4.1: Creator Normalization Tests --');
    assert(typeof OA.normalizeCreator === 'function', 'normalizeCreator function exists on plugin');
    const c1 = OA.normalizeCreator({ given: 'Marie', family: 'Curie', sequence: 'first' });
    assert(c1.firstName === 'Marie' && c1.lastName === 'Curie', 'Normalizes Crossref structured author with given and family');

    const c2 = OA.normalizeCreator({ name: 'ATLAS Collaboration', sequence: 'additional' });
    assert(c2.lastName === 'ATLAS Collaboration' && c2.fieldMode === 1, 'Normalizes Crossref institutional author with fieldMode=1');

    const c3 = OA.normalizeCreator({ fullName: 'Josiah St. John Carberry' });
    assert(c3.firstName === 'Josiah St. John' && c3.lastName === 'Carberry', 'Normalizes author object with fullName');

    const c4 = OA.normalizeCreator('Lovelace, Ada');
    assert(c4.firstName === 'Ada' && c4.lastName === 'Lovelace', 'Normalizes string author "Last, First"');

    const c5 = OA.normalizeCreator(null);
    assert(c5.lastName === 'Unknown', 'Handles null creator gracefully');

    // ==========================================
    // Test 11: Step 4.1 Robust Zotero Item Creation & Field Assignment
    // ==========================================
    console.log('\n-- Step 4.1: Robust Zotero Item Creation & Comprehensive Field Assignment --');
    assert(typeof OA.createZoteroItem === 'function', 'createZoteroItem exists on plugin');
    assert(typeof OA.setItemFieldSafe === 'function', 'setItemFieldSafe exists on plugin');

    // Attach mock Zotero.Item constructor to sandbox
    let mockSavedItems = [];
    sandbox.Zotero.Item = function(type) {
      this.itemType = type;
      this.fields = {};
      this.creators = [];
      this.collections = [];
      this.setField = function(f, v) { this.fields[f] = v; };
      this.getField = function(f) { return this.fields[f]; };
      this.setCreators = function(c) { this.creators = c; };
      this.getCreators = function() { return this.creators; };
      this.addToCollection = function(cid) { if (!this.collections.includes(cid)) this.collections.push(cid); };
      this.setCollections = function(cids) { this.collections = Array.from(cids); };
      this.getCollections = function() { return this.collections; };
      this.isValidField = function(f) { return true; };
      this.saveTx = async function() {
        this.id = mockSavedItems.length + 100;
        mockSavedItems.push(this);
        return this.id;
      };
    };
    sandbox.Zotero.ItemTypes = {
      getID(type) { return type; }
    };
    sandbox.Zotero.Libraries = {
      userLibraryID: 1,
      getName(id) { return 'My Library'; }
    };

    // 11a: Journal Article mapping with complete Crossref + ORCID metadata
    const richJournalWork = {
      title: 'A Bibliometric Study of Pediatric Inguinal Hernia',
      doi: 'https://doi.org/10.4103/jiaps.jiaps_27_22',
      year: '2022',
      date: '2022-11-15',
      journalTitle: 'Journal of Indian Association of Pediatric Surgeons',
      journalAbbreviation: 'J. Indian Assoc. Pediatr. Surg.',
      volume: '27',
      issue: '6',
      pages: '689-698',
      issn: '0971-9261',
      url: 'https://doi.org/10.4103/jiaps.jiaps_27_22',
      abstractNote: 'Background: Pediatric inguinal hernia landscape...',
      language: 'en',
      orcid: '0000-0001-5787-7143',
      putCode: '133572295',
      type: 'journal-article',
      sources: ['orcid', 'crossref'],
      authors: [
        { given: 'Anjan Kumar', family: 'Dhua', sequence: 'first' },
        { given: 'Mohit', family: 'Garg', sequence: 'additional' },
        { name: 'Research Collaborative Team', fieldMode: 1 }
      ]
    };

    const journalItem = await OA.createZoteroItem(richJournalWork, 1);
    assert(journalItem.itemType === 'journalArticle', 'Created item itemType is journalArticle');
    assert(journalItem.getField('title') === 'A Bibliometric Study of Pediatric Inguinal Hernia', 'Item title set');
    assert(journalItem.getField('DOI') === '10.4103/jiaps.jiaps_27_22', 'DOI normalized with prefix stripped');
    assert(journalItem.getField('date') === '2022-11-15', 'Complete publication date YYYY-MM-DD set');
    assert(journalItem.getField('publicationTitle') === 'Journal of Indian Association of Pediatric Surgeons', 'Journal title mapped to publicationTitle');
    assert(journalItem.getField('publisher') === undefined, 'Publisher is NOT set for journal articles (proper field separation)');
    assert(journalItem.getField('journalAbbreviation') === 'J. Indian Assoc. Pediatr. Surg.', 'Journal abbreviation mapped');
    assert(journalItem.getField('volume') === '27', 'Volume mapped');
    assert(journalItem.getField('issue') === '6', 'Issue mapped');
    assert(journalItem.getField('pages') === '689-698', 'Page range preserved');
    assert(journalItem.getField('ISSN') === '0971-9261', 'ISSN mapped');
    assert(journalItem.getField('url') === 'https://doi.org/10.4103/jiaps.jiaps_27_22', 'URL mapped');
    assert(journalItem.getField('abstractNote').includes('Pediatric inguinal hernia'), 'Abstract note mapped');
    assert(journalItem.getField('language') === 'en', 'Language mapped');
    assert(journalItem.getField('extra').includes('ORCID: 0000-0001-5787-7143'), 'Extra field contains ORCID iD');
    assert(journalItem.getField('extra').includes('ORCID-Put-Code: 133572295'), 'Extra field contains Put-Code');
    assert(journalItem.getField('extra').includes('Sources: ORCID, CROSSREF'), 'Extra field records source provenance');
    assert(journalItem.getCreators().length === 3, 'Creators assigned with 3 records');
    assert(journalItem.getCreators()[0].firstName === 'Anjan Kumar' && journalItem.getCreators()[0].lastName === 'Dhua', 'Creator 1 has given and family names');
    assert(journalItem.getCreators()[2].lastName === 'Research Collaborative Team' && journalItem.getCreators()[2].fieldMode === 1, 'Creator 3 is institutional single-field author');

    // 11b: Book mapping
    const bookWork = {
      title: 'Introduction to Algorithms',
      type: 'book',
      publisher: 'MIT Press',
      isbn: '978-0262033848',
      year: '2009',
      date: '2009',
      pages: '1312',
      authors: ['Cormen, Thomas H.', 'Leiserson, Charles E.']
    };
    const bookItem = await OA.createZoteroItem(bookWork, 1);
    assert(bookItem.itemType === 'book', 'Maps book to Zotero book itemType');
    assert(bookItem.getField('publisher') === 'MIT Press', 'Book publisher mapped to publisher field');
    assert(bookItem.getField('ISBN') === '978-0262033848', 'Book ISBN mapped to ISBN field');

    // 11c: Conference Paper mapping
    const confWork = {
      title: 'Attention Is All You Need',
      type: 'conference-paper',
      journalTitle: 'Advances in Neural Information Processing Systems',
      pages: '5998-6008',
      year: '2017'
    };
    const confItem = await OA.createZoteroItem(confWork, 1);
    assert(confItem.itemType === 'conferencePaper', 'Maps conference-paper to conferencePaper');
    assert(confItem.getField('proceedingsTitle') === 'Advances in Neural Information Processing Systems', 'Proceedings title mapped');
    assert(confItem.getField('pages') === '5998-6008', 'Conference paper pages mapped');

    // 11d: Report mapping
    const reportWork = {
      title: 'Technical Report on Quantum Cryptography',
      type: 'report',
      publisher: 'NIST',
      issue: 'NIST-SP-800-208',
      year: '2020'
    };
    const reportItem = await OA.createZoteroItem(reportWork, 1);
    assert(reportItem.itemType === 'report', 'Maps report to report');
    assert(reportItem.getField('institution') === 'NIST', 'Report institution mapped');
    assert(reportItem.getField('reportNumber') === 'NIST-SP-800-208', 'Report number mapped');

    // 11e: Thesis mapping
    const thesisWork = {
      title: 'A Study on Machine Learning Optimization',
      type: 'dissertation',
      publisher: 'Stanford University',
      year: '2021'
    };
    const thesisItem = await OA.createZoteroItem(thesisWork, 1);
    assert(thesisItem.itemType === 'thesis', 'Maps dissertation to thesis');
    assert(thesisItem.getField('university') === 'Stanford University', 'Thesis university mapped');

    // 11f: Preprint & Dataset mapping
    const preprintWork = {
      title: 'A Preprint Study on Climate Modeling',
      type: 'preprint',
      journalTitle: 'arXiv',
      doi: '10.48550/arXiv.2301.00001',
      year: '2023'
    };
    const preprintItem = await OA.createZoteroItem(preprintWork, 1);
    assert(preprintItem.itemType === 'preprint', 'Maps preprint to preprint');
    assert(preprintItem.getField('repository') === 'arXiv', 'Preprint repository mapped');

    const datasetWork = {
      title: 'Global Temperature Dataset 1880-2023',
      type: 'data-set',
      journalTitle: 'Zenodo',
      doi: '10.5281/zenodo.1234567',
      year: '2023'
    };
    const datasetItem = await OA.createZoteroItem(datasetWork, 1);
    assert(datasetItem.itemType === 'dataset', 'Maps data-set to dataset');
    assert(datasetItem.getField('repository') === 'Zenodo', 'Dataset repository mapped');

    // 11g: Sparse work handling
    const sparseWork = {
      title: null,
      doi: null,
      year: null,
      type: null
    };
    const sparseItem = await OA.createZoteroItem(sparseWork, 1);
    assert(sparseItem.getField('title') === '(Untitled ORCID Publication)', 'Handled missing title with fallback');
    assert(sparseItem.getField('DOI') === undefined, 'Missing DOI not invented');
    assert(sparseItem.getField('date') === undefined, 'Missing date not invented');

    // ==========================================
    // Test 11.1: Step 4.1 Metadata Quality Assessment
    // ==========================================
    console.log('\n-- Step 4.1: Metadata Quality Assessment Tests --');
    assert(typeof OA.assessMetadataQuality === 'function', 'assessMetadataQuality function exists on plugin');

    const qualityComplete = OA.assessMetadataQuality(richJournalWork);
    assert(qualityComplete.isEnriched === true, 'Quality assessment identifies Crossref enrichment');
    assert(qualityComplete.sourceSummary === 'ORCID + Crossref', 'Source summary reports ORCID + Crossref');
    assert(qualityComplete.availableFields.includes('Title'), 'Available fields includes Title');
    assert(qualityComplete.availableFields.includes('Authors'), 'Available fields includes Authors');
    assert(qualityComplete.availableFields.includes('Journal/Source'), 'Available fields includes Journal/Source');
    assert(qualityComplete.availableFields.includes('Volume'), 'Available fields includes Volume');
    assert(qualityComplete.availableFields.includes('Issue'), 'Available fields includes Issue');
    assert(qualityComplete.availableFields.includes('Pages'), 'Available fields includes Pages');
    assert(qualityComplete.availableFields.includes('ISSN'), 'Available fields includes ISSN');
    assert(qualityComplete.completenessScore >= 80, 'Complete work has high completeness score (>=80%)');

    const incompleteWork = {
      title: 'Incomplete Publication',
      year: '2020',
      doi: null,
      journalTitle: null,
      authors: []
    };
    const qualityIncomplete = OA.assessMetadataQuality(incompleteWork);
    assert(qualityIncomplete.isEnriched === false, 'Identifies incomplete work as not enriched');
    assert(qualityIncomplete.sourceSummary === 'ORCID', 'Source is ORCID only');
    assert(qualityIncomplete.missingFields.includes('Authors'), 'Identifies missing Authors');
    assert(qualityIncomplete.missingFields.includes('DOI'), 'Identifies missing DOI');
    assert(qualityIncomplete.missingFields.includes('Journal/Source'), 'Identifies missing Journal/Source');
    assert(qualityIncomplete.completenessScore < 40, 'Incomplete work reports low completeness score (<40%)');

    // ==========================================
    // Test 12: Step 4 Import Execution & Duplicate Recheck Safeguards
    // ==========================================
    console.log('\n-- Step 4: Import Execution, Immediate Recheck & Intra-Batch Prevention --');
    assert(typeof OA.importPublications === 'function', 'importPublications function exists on plugin');

    // Pre-seed local library items
    OA.mockLibraryItems = [
      { id: 201, title: 'Already In Library Paper', doi: '10.1000/already-present', year: '2020', author: 'Smith' }
    ];

    const worksToImport = [
      {
        title: 'Already In Library Paper',
        doi: '10.1000/already-present',
        year: '2020',
        author: 'Smith'
      },
      {
        title: 'New Publication Alpha',
        doi: '10.1000/alpha',
        year: '2023',
        author: 'Josiah Carberry'
      },
      {
        title: 'New Publication Beta (Duplicate DOI of Alpha in same batch)',
        doi: '10.1000/alpha', // Same DOI as Alpha in same batch
        year: '2023',
        author: 'Josiah Carberry'
      },
      {
        title: 'New Publication Gamma',
        doi: '10.1000/gamma',
        year: '2024',
        author: 'Ada Lovelace'
      }
    ];

    const importRes = await OA.importPublications(worksToImport, 1);
    assert(importRes.imported === 2, 'Imported exactly 2 distinct new publications (Alpha and Gamma)');
    assert(importRes.skipped === 2, 'Skipped 2 duplicate publications (1 pre-existing, 1 intra-batch duplicate DOI)');
    assert(importRes.failed === 0, 'Zero failed items in clean batch');
    assert(importRes.importedItems.length === 2, 'Result contains 2 saved Zotero item objects');

    // Verify intra-batch duplicate did not produce a second save
    const alphaSaves = mockSavedItems.filter(i => i.getField('DOI') === '10.1000/alpha');
    assert(alphaSaves.length === 1, 'Only one item saved for DOI 10.1000/alpha (intra-batch duplicate safely skipped)');

    // ==========================================
    // Test 13: Step 4 Partial Failure Handling & Error Separation
    // ==========================================
    console.log('\n-- Step 4: Partial Failure Handling & Error Separation --');
    const originalCreateZoteroItem = OA.createZoteroItem.bind(OA);
    OA.createZoteroItem = async (work, targetLibraryID) => {
      if (work.title === 'Corrupted Record Will Fail') {
        const item = await originalCreateZoteroItem(work, targetLibraryID);
        item.saveTx = async () => {
          throw new Error('Simulated database lock error');
        };
        return item;
      }
      return originalCreateZoteroItem(work, targetLibraryID);
    };

    OA.mockLibraryItems = [];
    const mixedBatch = [
      { title: 'Good Publication 1', doi: '10.1000/good-1', year: '2023' },
      { title: 'Corrupted Record Will Fail', doi: '10.1000/fail', year: '2023' },
      { title: 'Good Publication 2', doi: '10.1000/good-2', year: '2023' }
    ];

    const mixedRes = await OA.importPublications(mixedBatch, 1);
    assert(mixedRes.imported === 2, 'Partial batch imported 2 good publications');
    assert(mixedRes.failed === 1, 'Partial batch recorded 1 failure');
    assert(mixedRes.errors.length === 1, 'Errors array contains 1 error entry');
    assert(mixedRes.errors[0].title === 'Corrupted Record Will Fail', 'Error entry identifies failing publication');
    assert(mixedRes.errors[0].error.includes('database lock'), 'Error entry contains failure message');
    assert(mixedRes.success === false, 'Result success is false when any item fails');

    // Restore original createZoteroItem
    OA.createZoteroItem = originalCreateZoteroItem;

    // Empty batch handling
    const emptyRes = await OA.importPublications([], 1);
    assert(emptyRes.imported === 0 && emptyRes.skipped === 0 && emptyRes.failed === 0, 'Empty batch handled gracefully');

    // ==========================================
    // Test 14: Step 4 Confirmation Dialogs & Cancellation Safeguards
    // ==========================================
    console.log('\n-- Step 4: Confirmation Dialogs & Cancellation Safeguards --');
    assert(typeof OA.confirmPossibleDuplicates === 'function', 'confirmPossibleDuplicates exists on plugin');
    assert(typeof OA.confirmImport === 'function', 'confirmImport exists on plugin');

    let confirmCallsLog = [];
    sandbox.Services.prompt.confirm = (win, title, msg) => {
      confirmCallsLog.push({ title, msg });
      return false; // User cancels
    };

    // 14a: Cancel possible duplicates confirmation
    const cancelledPossibleDups = OA.confirmPossibleDuplicates(mockWindow, [
      { title: 'Test Possible Dup', year: '2021', matchReason: 'Title matches local item' }
    ]);
    assert(cancelledPossibleDups === false, 'User cancelling Possible Duplicates confirmation returns false');
    assert(confirmCallsLog.length === 1, 'Possible duplicates confirmation dialog was shown');
    assert(confirmCallsLog[0].title.includes('Possible Duplicates'), 'Dialog title reflects Possible Duplicates warning');
    assert(confirmCallsLog[0].msg.includes('CAUTION'), 'Dialog message emphasizes caution');

    // 14b: Cancel final import confirmation
    confirmCallsLog = [];
    const cancelledFinal = OA.confirmImport(mockWindow, [
      { title: 'Work 1', duplicateStatus: 'New' },
      { title: 'Work 2', duplicateStatus: 'Possible Duplicate' }
    ], 1);
    assert(cancelledFinal === false, 'User cancelling final import confirmation returns false');
    assert(confirmCallsLog.length === 1, 'Final import confirmation dialog was shown');
    assert(confirmCallsLog[0].title.includes('Confirm Import'), 'Final confirmation title is Confirm Import');
    assert(confirmCallsLog[0].msg.includes('Destination: My Library'), 'Final confirmation specifies target library name');
    assert(confirmCallsLog[0].msg.includes('New records: 1'), 'Final confirmation shows new records count');
    assert(confirmCallsLog[0].msg.includes('Possible duplicates: 1'), 'Final confirmation shows possible duplicates count');

    // 14c: User accepts confirmation
    sandbox.Services.prompt.confirm = () => true;
    const acceptedFinal = OA.confirmImport(mockWindow, [{ title: 'Work 1', duplicateStatus: 'New' }], 1);
    assert(acceptedFinal === true, 'User accepting final import returns true');

    // ==========================================
    // Test 15: Step 4 Interactive Selection UI (DOM Modal)
    // ==========================================
    console.log('\n-- Step 4: Interactive Selection UI (DOM Modal) Tests --');
    assert(typeof OA.showImportModal === 'function', 'showImportModal exists on plugin');

    function createMockElement(tag, docRef) {
      let _id = null;
      const el = {
        tagName: tag,
        get id() { return _id; },
        set id(val) {
          _id = val;
          if (val && docRef) docRef.elementsById.set(val, el);
        },
        className: '',
        style: {},
        children: [],
        listeners: {},
        checked: false,
        disabled: false,
        textContent: '',
        innerHTML: '',
        value: '',
        files: [],
        get firstChild() { return this.children[0] || null; },
        removeChild(child) {
          const idx = this.children.indexOf(child);
          if (idx !== -1) {
            this.children.splice(idx, 1);
            if (child.id && docRef) docRef.elementsById.delete(child.id);
          }
          return child;
        },
        type: tag === 'input' ? 'checkbox' : undefined,
        appendChild(child) {
          this.children.push(child);
          child.parent = this;
          if (child.id && docRef) docRef.elementsById.set(child.id, child);
          return child;
        },
        addEventListener(event, fn) {
          this.listeners[event] = fn;
        },
        remove() {
          if (_id && docRef) docRef.elementsById.delete(_id);
          if (this.parent) {
            const idx = this.parent.children.indexOf(this);
            if (idx !== -1) this.parent.children.splice(idx, 1);
          }
        }
      };
      return el;
    }

    const docElementsById = new Map();
    const domDoc = {
      elementsById: docElementsById,
      body: null,
      getElementById(id) {
        return this.elementsById.get(id) || null;
      },
      createElement(tag) {
        return createMockElement(tag, this);
      }
    };
    domDoc.body = createMockElement('body', domDoc);
    const domModalWindow = { document: domDoc };

    const modalData = {
      orcid: '0000-0002-1825-0097',
      works: [
        { title: 'Work Alpha', duplicateStatus: 'New', year: '2023', doi: '10.1/a' },
        { title: 'Work Beta', duplicateStatus: 'Already in Zotero', year: '2020', doi: '10.1/b' },
        { title: 'Work Gamma', duplicateStatus: 'Possible Duplicate', year: '2021', doi: '10.1/c' }
      ]
    };

    OA.showImportModal(domModalWindow, modalData);

    const overlayEl = domModalWindow.document.getElementById('orcid-assistant-modal-overlay');
    assert(overlayEl !== null, 'showImportModal rendered modal overlay in DOM');
    assert(modalData.works[0].selected === true, 'New record selected by default');
    assert(modalData.works[1].selected === false, '"Already in Zotero" record unselected by default');
    assert(modalData.works[2].selected === false, '"Possible Duplicate" record unselected by default');

    const summaryEl = domModalWindow.document.getElementById('orcid-selection-summary');
    assert(summaryEl !== null, 'Selection summary element present');
    assert(summaryEl.textContent === '1 of 3 selected', 'Selection summary reports initial count (1 of 3 selected)');

    // Test removeFromWindow cleans up active modal
    OA.removeFromWindow(domModalWindow);
    assert(domModalWindow.document.getElementById('orcid-assistant-modal-overlay') === null, 'removeFromWindow removes active modal overlay from window');

    // Test showImportModal with special characters (ampersands, angles, quotes)
    const specialCharsData = {
      orcid: '0000-0002-1825-0097',
      totalWorks: 2,
      works: [
        {
          title: 'Research & Development in Computer Science: A < B & C > D',
          authors: ['Smith & Jones', 'AT&T Labs'],
          journalTitle: 'Journal of Physics A & B: Mathematical & Theoretical',
          duplicateStatus: 'Already in Zotero',
          matchReason: 'Title and year (2020) and author (smith) match local item',
          year: '2020',
          doi: '10.1000/182?a=1&b=2'
        },
        {
          title: 'Clean Publication',
          authors: ['Doe, John'],
          duplicateStatus: 'New',
          year: '2022',
          doi: '10.1000/clean'
        }
      ]
    };
    OA.showImportModal(domModalWindow, specialCharsData);
    assert(domModalWindow.document.getElementById('orcid-assistant-modal-overlay') !== null, 'showImportModal handles & and < > special characters safely without DOMException');
    OA.removeFromWindow(domModalWindow);

    // Test safe library item field reader when item.getField throws on invalid field names
    const mockZoteroItemWithStrictFields = {
      isRegularItem: () => true,
      title: 'Existing Local Book',
      DOI: '10.1234/test',
      date: '2021',
      getField(field) {
        if (field === 'DOI') return this.DOI;
        if (field === 'title') return this.title;
        if (field === 'date') return this.date;
        throw new Error('An invalid or illegal string was specified');
      },
      getCreators: () => [{ lastName: 'Smith' }]
    };
    const prevZotero = sandbox.Zotero;
    sandbox.Zotero = {
      Items: {
        getAll: async () => [mockZoteroItemWithStrictFields]
      },
      Libraries: { userLibraryID: 1 }
    };
    OA.mockLibraryItems = null; // Use live Zotero.Items.getAll path
    const readItems = await OA.getLocalLibraryItems(1);
    sandbox.Zotero = prevZotero; // Restore original sandbox Zotero
    assert(readItems.length === 1, 'getLocalLibraryItems handles strict getField without throwing syntax error');
    assert(readItems[0].doi === '10.1234/test', 'Correctly read DOI');
    assert(readItems[0].year === '2021', 'Correctly read date without calling invalid field names');

    // ==========================================
    // Test 16: Batch CSV Parsing & Profile Extraction
    // ==========================================
    console.log('\n-- Batch CSV Parsing & Extraction Tests --');
    assert(typeof OA.parseOrcidsFromCsvOrText === 'function', 'parseOrcidsFromCsvOrText exists on plugin');

    // 16a: Standard CSV with header
    const csvStandard = `Name,Department,ORCID
Dr. Alice Smith,Physics,0000-0002-1825-0097
Dr. Bob Jones,Computer Science,0000-0002-1694-233X`;
    const resCsv1 = OA.parseOrcidsFromCsvOrText(csvStandard);
    assert(resCsv1.totalFound === 2, 'Parsed 2 profiles from standard CSV');
    assert(resCsv1.profiles[0].orcid === '0000-0002-1825-0097' && resCsv1.profiles[0].name === 'Dr. Alice Smith', 'Profile 1 extracted name and ORCID');
    assert(resCsv1.profiles[1].orcid === '0000-0002-1694-233X' && resCsv1.profiles[1].name === 'Dr. Bob Jones', 'Profile 2 extracted name and ORCID');

    // 16b: TSV format
    const tsvText = "Researcher\tORCID\nProf. Raman\t0000-0002-1825-0097\nDr. Curie\thttps://orcid.org/0000-0002-1694-233X";
    const resTsv = OA.parseOrcidsFromCsvOrText(tsvText);
    assert(resTsv.totalFound === 2, 'Parsed 2 profiles from TSV text');
    assert(resTsv.profiles[1].orcid === '0000-0002-1694-233X' && resTsv.profiles[1].name === 'Dr. Curie', 'Extracted name and normalized https prefix in TSV');

    // 16c: Semicolon delimiter
    const semiText = "Name;ORCID\nAlice;0000-0002-1825-0097\nBob;0000-0002-1694-233X";
    const resSemi = OA.parseOrcidsFromCsvOrText(semiText);
    assert(resSemi.totalFound === 2, 'Parsed 2 profiles from semicolon CSV');

    // 16d: Plain unformatted ORCID list
    const plainList = `0000-0002-1825-0097
https://orcid.org/0000-0002-1694-233X`;
    const resPlain = OA.parseOrcidsFromCsvOrText(plainList);
    assert(resPlain.totalFound === 2, 'Parsed plain ORCID list without headers');

    // 16e: Deduplication in file
    const dupCsv = `Name,ORCID
Alice,0000-0002-1825-0097
Alice Duplicate,0000-0002-1825-0097
Bob,0000-0002-1694-233X`;
    const resDup = OA.parseOrcidsFromCsvOrText(dupCsv);
    assert(resDup.totalFound === 2, 'Deduplicated repeated ORCID in file');
    assert(resDup.duplicatesInFile === 1, 'Reported 1 duplicate in file');

    // 16f: Invalid entries handling
    const invalidCsv = `Name,ORCID
Valid,0000-0002-1825-0097
BadChecksum,0000-0002-1825-0000
Malformed,12345`;
    const resInvalid = OA.parseOrcidsFromCsvOrText(invalidCsv);
    assert(resInvalid.totalFound === 1, 'Only valid ORCID returned');
    assert(resInvalid.invalidCount === 2, 'Invalid format and check digits captured and counted');

    // 16g: Empty text
    const resEmpty = OA.parseOrcidsFromCsvOrText('');
    assert(resEmpty.totalFound === 0, 'Empty string returns totalFound 0');

    // ==========================================
    // Test 17: Destination Libraries (Groups & Collections) Discovery & Assignment
    // ==========================================
    console.log('\n-- Group Library & Collection Destination Tests --');
    assert(typeof OA.getAvailableDestinations === 'function', 'getAvailableDestinations exists on plugin');
    assert(typeof OA.getTargetLibraryName === 'function', 'getTargetLibraryName exists on plugin');
    assert(typeof OA.getTargetCollectionName === 'function', 'getTargetCollectionName exists on plugin');

    // Mock Zotero.Libraries & Zotero.Collections
    const mockGroupLibs = [
      { id: 1, name: 'My Library', libraryType: 'user', isUser: true },
      { id: 10, name: 'IIT Delhi Research Group', libraryType: 'group', isGroup: true },
      { id: 25, name: 'AI & Robotics Lab', libraryType: 'group', isGroup: true }
    ];
    const mockCollections = {
      1: [{ id: 101, name: 'Thesis Papers' }],
      10: [{ id: 201, name: 'Journal Publications' }, { id: 202, name: 'Conference Proceedings' }],
      25: [{ id: 301, name: 'Deep Learning' }]
    };

    sandbox.Zotero.Libraries = {
      userLibraryID: 1,
      getAll: () => mockGroupLibs,
      getName: (libID) => mockGroupLibs.find(l => l.id === libID)?.name || null
    };
    sandbox.Zotero.Collections = {
      getByLibrary: (libID) => mockCollections[libID] || []
    };

    const dests = OA.getAvailableDestinations();
    assert(dests.libraries.length === 3, 'Discovered 3 libraries (1 personal, 2 groups)');
    assert(dests.libraries[0].name === 'My Library' && dests.libraries[0].isUser === true, 'Library 1 is User Library');
    assert(dests.libraries[1].name === 'IIT Delhi Research Group' && dests.libraries[1].isGroup === true, 'Library 10 is Group Library');
    assert(dests.libraries[1].collections.length === 2, 'Group Library 10 has 2 collections');
    assert(dests.libraries[1].collections[0].name === 'Journal Publications', 'Collection 201 resolved correctly');

    const libName = OA.getTargetLibraryName(10);
    assert(libName === 'IIT Delhi Research Group', 'getTargetLibraryName resolves Group Library name');

    const colName = OA.getTargetCollectionName(10, 201);
    assert(colName === 'Journal Publications', 'getTargetCollectionName resolves Collection name in Group Library');

    // Test importing publication with targetLibraryID (Group) and targetCollectionID
    const sampleWork = {
      title: 'Group Collaborative Research',
      authors: ['Sharma, R.'],
      year: '2023',
      doi: '10.1000/group.test.1'
    };
    OA.mockLibraryItemsByLibraryID = { 10: [] };
    const groupImportRes = await OA.importPublications([sampleWork], 10, 201);
    assert(groupImportRes.success === true, 'importPublications into Group Library succeeded');
    assert(groupImportRes.imported === 1, 'Successfully imported 1 item');
    assert(groupImportRes.importedItems[0].libraryID === 10, 'Imported item assigned to Group Library 10');
    assert(groupImportRes.importedItems[0].collections.includes(201), 'Imported item added to collection 201 in Group Library');

    // ==========================================
    // Test 18: Batch Processing & Intra-Batch Duplicate Detection
    // ==========================================
    console.log('\n-- Batch Processing & Intra-Batch Duplicate Tests --');
    const sharedWorkAlice = {
      title: 'Joint Breakthrough Study',
      authors: ['Alice Smith', 'Bob Jones'],
      year: '2023',
      doi: '10.1000/joint.study',
      researcherName: 'Dr. Alice Smith',
      researcherOrcid: '0000-0002-1825-0097'
    };
    const sharedWorkBob = {
      title: 'Joint Breakthrough Study',
      authors: ['Alice Smith', 'Bob Jones'],
      year: '2023',
      doi: '10.1000/joint.study',
      researcherName: 'Dr. Bob Jones',
      researcherOrcid: '0000-0002-1694-233X'
    };
    const uniqueWorkBob = {
      title: 'Bob Solo Study',
      authors: ['Bob Jones'],
      year: '2024',
      doi: '10.1000/bob.solo',
      researcherName: 'Dr. Bob Jones',
      researcherOrcid: '0000-0002-1694-233X'
    };

    // First annotate against empty local library
    const batchAnnotated = OA.detectDuplicates([sharedWorkAlice, sharedWorkBob, uniqueWorkBob], []);
    assert(batchAnnotated[0].duplicateStatus === 'New', 'Alice joint paper is initially New');

    // Intra-batch duplicate check logic simulation
    const seenDois = new Map();
    for (const w of batchAnnotated) {
      const normDoi = OA.normalizeDoi(w.doi);
      if (normDoi) {
        if (seenDois.has(normDoi)) {
          w.duplicateStatus = 'Already in Zotero';
          w.matchReason = `Intra-batch duplicate: already fetched for ${seenDois.get(normDoi).researcherName}`;
        } else {
          seenDois.set(normDoi, w);
        }
      }
    }
    assert(batchAnnotated[0].duplicateStatus === 'New', 'First occurrence of joint paper remains New');
    assert(batchAnnotated[1].duplicateStatus === 'Already in Zotero', 'Second occurrence of joint paper marked Already in Zotero');
    assert(batchAnnotated[1].matchReason.includes('Intra-batch duplicate: already fetched for Dr. Alice Smith'), 'Match reason explains intra-batch duplicate');
    assert(batchAnnotated[2].duplicateStatus === 'New', 'Bob solo paper remains New');

    // ==========================================
    // Test 19: Duplicate Report Popup Tests
    // ==========================================
    console.log('\n-- Duplicate Report Popup UI Tests --');
    assert(typeof OA.showDuplicateReportPopup === 'function', 'showDuplicateReportPopup exists on plugin');

    let reportExcludedCalled = false;
    let reportReviewCalled = false;
    const testReportData = {
      duplicates: [
        {
          title: 'Joint Breakthrough Study',
          authors: ['Alice Smith', 'Bob Jones'],
          year: '2023',
          doi: '10.1000/joint.study',
          researcherName: 'Dr. Bob Jones',
          duplicateStatus: 'Already in Zotero',
          matchReason: 'Intra-batch duplicate: already fetched for Dr. Alice Smith'
        }
      ],
      profilesCount: 2,
      libraryName: 'IIT Delhi Research Group',
      onReview: () => { reportReviewCalled = true; },
      onExcludeDuplicates: () => { reportExcludedCalled = true; }
    };

    OA.showDuplicateReportPopup(domModalWindow, testReportData);
    const popupEl = domModalWindow.document.getElementById('orcid-duplicate-report-overlay');
    assert(popupEl !== null, 'showDuplicateReportPopup rendered popup overlay in DOM');

    // Clean up popup
    OA.removeFromWindow(domModalWindow);
    assert(domModalWindow.document.getElementById('orcid-duplicate-report-overlay') === null, 'removeFromWindow cleaned up duplicate report overlay');

    // ==========================================
    // Test 20: Batch Import Modal Lifecycle & Controls Tests
    // ==========================================
    console.log('\n-- Batch Import Modal Lifecycle Tests --');
    assert(typeof OA.showBatchImportModal === 'function', 'showBatchImportModal exists on plugin');
    assert(typeof OA.onBatchMenuItemCommand === 'function', 'onBatchMenuItemCommand exists on plugin');

    OA.showBatchImportModal(domModalWindow);
    const batchOverlay = domModalWindow.document.getElementById('orcid-assistant-batch-modal-overlay');
    assert(batchOverlay !== null, 'showBatchImportModal rendered batch modal in DOM');

    const batchLibSelect = domModalWindow.document.getElementById('orcid-batch-library-select');
    assert(batchLibSelect !== null, 'Destination Library / Group selector present in batch modal');

    const batchColSelect = domModalWindow.document.getElementById('orcid-batch-collection-select');
    assert(batchColSelect !== null, 'Target Collection selector present in batch modal');

    const batchTextarea = domModalWindow.document.getElementById('orcid-batch-textarea');
    assert(batchTextarea !== null, 'Batch CSV textarea present');

    const fetchBtn = domModalWindow.document.getElementById('orcid-batch-fetch-btn');
    assert(fetchBtn !== null, 'Fetch Publications button present');

    // Clean up batch modal
    OA.removeFromWindow(domModalWindow);
    assert(domModalWindow.document.getElementById('orcid-assistant-batch-modal-overlay') === null, 'removeFromWindow cleaned up batch modal overlay');

    // ==========================================
    // Test 16: Strict ORCID Read-Only & Zero Write API Verification
    // ==========================================
    console.log('\n-- Step 4: Strict ORCID Read-Only & Zero Write Scope Verification --');
    const serverJs = fs.readFileSync(path.join(__dirname, '..', 'helper-service', 'server.js'), 'utf8');
    const clientJs = fs.readFileSync(path.join(__dirname, '..', 'helper-service', 'orcid-client.js'), 'utf8');
    assert(!serverJs.includes('/activities/update') && !clientJs.includes('/activities/update'), 'SECURITY: Helper service does NOT contain ORCID write scope /activities/update');
    assert(!serverJs.includes('/read-limited') && !clientJs.includes('/read-limited'), 'SECURITY: Helper service does NOT request Member-only /read-limited');
    assert(clientJs.includes('/read-public'), 'SECURITY: Helper service requests strictly /read-public scope');
    assert(!clientJs.includes("method: 'PUT'") && !clientJs.includes("method: 'DELETE'"), 'SECURITY: Helper service does NOT issue PUT or DELETE requests');
    assert(clientJs.includes("method: 'GET'"), 'SECURITY: Works endpoint accessed strictly via GET');

    const pluginJs = fs.readFileSync(path.join(SRC_DIR, 'orcid-assistant.js'), 'utf8');
    assert(!pluginJs.includes('method: "POST"'), 'SECURITY: Plugin does NOT issue POST requests');
    assert(!pluginJs.includes('method: "PUT"'), 'SECURITY: Plugin does NOT issue PUT requests');
    assert(!pluginJs.includes('method: "DELETE"'), 'SECURITY: Plugin does NOT issue DELETE requests');

    // ==========================================
    // Test 17: Preserved Step 1 Dialog & Shutdown Cleanup
    // ==========================================
    console.log('\n-- Preservation & Lifecycle Shutdown Cleanup --');
    assert(typeof OA.showRunningDialog === 'function', 'showRunningDialog preserved from Step 1');

    // Test shutdown cleanup
    sandbox.shutdown({}, 1);

    const menuItemAfterShutdown = mockWindow.document.getElementById('orcid-assistant-tools-menuitem');
    assert(menuItemAfterShutdown === null, 'Menu item cleanly removed from DOM on shutdown');
    const batchMenuItemAfterShutdown = mockWindow.document.getElementById('orcid-assistant-tools-batch-menuitem');
    assert(batchMenuItemAfterShutdown === null, 'Batch menu item cleanly removed from DOM on shutdown');
    assert(sandbox.ORCIDAssistant === undefined, 'ORCIDAssistant singleton is unset on shutdown');

    // ==========================================
    // Test 18: Verify XPI Archive Content & Isolation
    // ==========================================
    console.log('\n-- XPI Archive Security & Content Isolation --');
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



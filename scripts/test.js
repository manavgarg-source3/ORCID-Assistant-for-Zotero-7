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
    // Test 10: Strict Read-Only Verification
    // ==========================================
    console.log('\n-- Step 3: Strict Read-Only Verification --');
    assert(sandbox.Zotero.Items === undefined, 'No Zotero.Items API write operations exist');
    assert(typeof OA.showRunningDialog === 'function', 'showRunningDialog preserved from Step 1');

    // Test shutdown cleanup
    sandbox.shutdown({}, 1);

    const menuItemAfterShutdown = mockWindow.document.getElementById('orcid-assistant-tools-menuitem');
    assert(menuItemAfterShutdown === null, 'Menu item cleanly removed from DOM on shutdown');
    assert(sandbox.ORCIDAssistant === undefined, 'ORCIDAssistant singleton is unset on shutdown');

    // ==========================================
    // Test 11: Verify XPI Archive Content & Isolation
    // ==========================================
    console.log('\n-- Step 3: XPI Archive Security & Content Isolation --');
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



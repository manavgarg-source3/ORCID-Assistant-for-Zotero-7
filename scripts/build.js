/**
 * build.js - Packages the ORCID Assistant plugin into an installable .xpi file
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const OUTPUT_XPI = path.join(DIST_DIR, 'orcid-assistant.xpi');

console.log('=== Building ORCID Assistant Zotero Plugin ===\n');

// 1. Verify required source files
const requiredFiles = [
  'manifest.json',
  'bootstrap.js',
  'orcid-assistant.js',
  'prefs.js',
  'locale/en-US/orcid-assistant.ftl'
];

for (const relPath of requiredFiles) {
  const fullPath = path.join(SRC_DIR, relPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`ERROR: Missing required file: ${fullPath}`);
    process.exit(1);
  }
}
console.log('✔ All required source files verified.');

// 2. Validate manifest.json syntax
try {
  const manifestRaw = fs.readFileSync(path.join(SRC_DIR, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  if (!manifest.manifest_version || !manifest.name || !manifest.version) {
    throw new Error('manifest.json is missing required fields (manifest_version, name, version)');
  }
  const zoteroApp = manifest.applications?.zotero || manifest.browser_specific_settings?.zotero;
  if (!zoteroApp || !zoteroApp.id) {
    throw new Error('manifest.json must specify an application id for zotero');
  }
  console.log(`✔ Manifest valid: ${manifest.name} v${manifest.version} (ID: ${zoteroApp.id})`);
} catch (e) {
  console.error(`ERROR: manifest.json validation failed: ${e.message}`);
  process.exit(1);
}

// 3. Ensure dist directory exists
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

// 4. Create ZIP archive (XPI)
const zip = new AdmZip();

// Recursively add all files in SRC_DIR preserving relative paths
function addDirectory(dirPath, zipPath = '') {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullEntryPath = path.join(dirPath, entry.name);
    const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      addDirectory(fullEntryPath, entryZipPath);
    } else {
      const fileBuffer = fs.readFileSync(fullEntryPath);
      zip.addFile(entryZipPath, fileBuffer);
    }
  }
}

addDirectory(SRC_DIR);
zip.writeZip(OUTPUT_XPI);

// 5. Verify XPI contents
const verifyZip = new AdmZip(OUTPUT_XPI);
const zipEntries = verifyZip.getEntries().map(e => e.entryName);

const rootManifest = zipEntries.includes('manifest.json');
const rootBootstrap = zipEntries.includes('bootstrap.js');

if (!rootManifest || !rootBootstrap) {
  console.error('ERROR: XPI verification failed - manifest.json or bootstrap.js not found at archive root!');
  process.exit(1);
}

const stats = fs.statSync(OUTPUT_XPI);
console.log(`\n✔ Packaged XPI successfully: ${OUTPUT_XPI}`);
console.log(`  Size: ${(stats.size / 1024).toFixed(2)} KB`);
console.log(`  Archive Entries (${zipEntries.length}):`);
zipEntries.forEach(entry => console.log(`    - ${entry}`));
console.log('\nBuild completed successfully.');

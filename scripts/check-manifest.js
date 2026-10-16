const AdmZip = require('adm-zip');

const zip = new AdmZip('C:/Program Files/Zotero/app/omni.ja');
const text = zip.readAsText('chrome/content/zotero/xpcom/pluginAPI/menuManager.js');

let idx = text.indexOf('"main/menubar/tools"');
console.log(text.slice(idx - 50, idx + 200));

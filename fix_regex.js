const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'manager.html');
let content = fs.readFileSync(filePath, 'utf8');

// The file literally has 'replace(/\\s+/g, \'\')' due to previous tool escaping over-correction
// We want to replace it with 'replace(/\s+/g, \'\')'
const searchPattern = /replace\(\/\\\\s\+\/g, ''\)/g;
const replacePattern = "replace(/\\s+/g, '')";

content = content.replace(searchPattern, replacePattern);
fs.writeFileSync(filePath, content, 'utf8');

console.log('Regex fixed successfully in manager.html');

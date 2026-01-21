const XLSX = require('xlsx');
const fs = require('fs');

try {
    // Read the file
    const workbook = XLSX.readFile('بضاعة جاهزة.xlsx');
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Convert to JSON
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // Extract names (assuming they are in the first column or finding non-empty rows)
    const products = [];
    data.forEach(row => {
        if (row[0] && typeof row[0] === 'string') {
            products.push(row[0].trim());
        }
    });

    console.log(JSON.stringify(products, null, 2));
} catch (error) {
    console.error('Error reading file:', error.message);
}

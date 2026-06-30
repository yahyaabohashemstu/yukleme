'use strict';
// Pre-generate webp thumbnails for every existing upload, so the first gallery
// view is instant (otherwise thumbnails are generated lazily on first request).
//
// Usage:  node scripts/gen_thumbs.js
// Honors UPLOADS_DIR (defaults to ../uploads). Safe to re-run (skips existing).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
const THUMBS_DIR = path.join(UPLOADS_DIR, 'thumbs');
fs.mkdirSync(THUMBS_DIR, { recursive: true });

(async () => {
    const files = fs
        .readdirSync(UPLOADS_DIR)
        .filter((f) => !f.startsWith('.') && fs.statSync(path.join(UPLOADS_DIR, f)).isFile());

    let done = 0, skip = 0, fail = 0;
    for (const name of files) {
        const dest = path.join(THUMBS_DIR, name);
        if (fs.existsSync(dest)) { skip++; continue; }
        try {
            const tmp = `${dest}.tmp-${Math.random().toString(16).slice(2)}`;
            await sharp(path.join(UPLOADS_DIR, name), { failOn: 'none', animated: false })
                .rotate()
                .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 75 })
                .toFile(tmp);
            fs.renameSync(tmp, dest);
            done++;
            if (done % 50 === 0) console.log(`  ...${done} generated`);
        } catch (e) {
            fail++; // non-image (e.g. video) or unreadable — skipped, original still served
        }
    }
    console.log(`thumbnails: generated ${done}, skipped(existing) ${skip}, non-image/failed ${fail}, total ${files.length}`);
})();

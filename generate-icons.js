const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

// Source icon path - Using absolute path
const SOURCE_ICON = 'C:\\Users\\YAHYA\\.gemini\\antigravity\\brain\\b9158e97-7d41-4aa3-87e8-67c8610d4860\\pwa_app_icon_1770200997703.png';
const OUTPUT_DIR = path.join(__dirname, 'public', 'icons');

// Icon sizes to generate
const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];

async function generateIcons() {
    console.log('🎨 Starting icon generation...');
    console.log('📁 Source:', SOURCE_ICON);
    console.log('📂 Output:', OUTPUT_DIR);

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Check if source exists
    if (!fs.existsSync(SOURCE_ICON)) {
        console.error('❌ Source icon not found:', SOURCE_ICON);
        process.exit(1);
    }

    try {
        // Generate each size
        for (const size of SIZES) {
            const outputPath = path.join(OUTPUT_DIR, `icon-${size}x${size}.png`);

            await sharp(SOURCE_ICON)
                .resize(size, size, {
                    fit: 'cover',
                    position: 'center'
                })
                .png({ quality: 100 })
                .toFile(outputPath);

            console.log(`✅ Generated: icon-${size}x${size}.png`);
        }

        // Generate maskable icon (with padding for safe zone)
        const maskableOutputPath = path.join(OUTPUT_DIR, 'maskable-icon.png');

        // For maskable icons, we need to add padding (safe zone is 80% of the icon)
        // So we resize the original to 80% and add padding
        const maskableSize = 512;
        const iconSize = Math.floor(maskableSize * 0.8); // 80% for safe zone
        const padding = Math.floor((maskableSize - iconSize) / 2);

        await sharp(SOURCE_ICON)
            .resize(iconSize, iconSize, {
                fit: 'cover',
                position: 'center'
            })
            .extend({
                top: padding,
                bottom: padding,
                left: padding,
                right: padding,
                background: { r: 79, g: 70, b: 229, alpha: 1 } // Primary color
            })
            .png({ quality: 100 })
            .toFile(maskableOutputPath);

        console.log('✅ Generated: maskable-icon.png');

        // Copy 192x192 as apple-touch-icon
        const appleTouchPath = path.join(OUTPUT_DIR, 'apple-touch-icon.png');
        fs.copyFileSync(
            path.join(OUTPUT_DIR, 'icon-192x192.png'),
            appleTouchPath
        );
        console.log('✅ Generated: apple-touch-icon.png');

        // Generate favicon.ico (use 96x96)
        const faviconPath = path.join(__dirname, 'public', 'favicon.ico');
        await sharp(SOURCE_ICON)
            .resize(32, 32)
            .png()
            .toFile(path.join(OUTPUT_DIR, 'favicon-32x32.png'));
        console.log('✅ Generated: favicon-32x32.png');

        console.log('\n🎉 All icons generated successfully!');
        console.log(`📁 Icons saved to: ${OUTPUT_DIR}`);

    } catch (error) {
        console.error('❌ Error generating icons:', error);
        process.exit(1);
    }
}

generateIcons();

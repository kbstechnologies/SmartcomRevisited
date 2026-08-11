# Smartcom Revisited Icons

This directory contains icon files for different platforms:

## Required Icon Files:

### Windows (.ico)
- `icon.ico` - Main application icon (256x256, 128x128, 64x64, 48x48, 32x32, 16x16)

### macOS (.icns)  
- `icon.icns` - Mac application icon (1024x1024 down to 16x16)

### Linux (.png)
Multiple PNG files for different sizes:
- `16x16.png`
- `24x24.png` 
- `32x32.png`
- `48x48.png`
- `64x64.png`
- `128x128.png`
- `256x256.png`
- `512x512.png`

## Creating Icons

You can create these from a source SVG or PNG using tools like:

- **Windows**: Use online converters or tools like IcoFX
- **macOS**: `iconutil` command line tool
- **Cross-platform**: `electron-icon-builder` npm package

### Quick Icon Generation:

```bash
# Install icon builder
npm install -g electron-icon-builder

# Generate all icons from source (requires 1024x1024 PNG)
electron-icon-builder --input=source-icon.png --output=build/icons --flatten
```

## Placeholder Icons

For development, you can use simple colored squares or download free icons from:
- https://iconmonstr.com/
- https://feathericons.com/
- https://heroicons.com/

The icons should represent an SSH/terminal theme with networking elements.
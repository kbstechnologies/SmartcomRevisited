#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

console.log('🔧 Fixing Windows build issues...')

// Remove problematic node_modules that cause build issues
const problematicModules = [
  'node_modules/cpu-features',
  'node_modules/@electron/remote/node_modules/cpu-features'
]

for (const modulePath of problematicModules) {
  const fullPath = path.resolve(modulePath)
  if (fs.existsSync(fullPath)) {
    console.log(`Removing ${modulePath}...`)
    fs.rmSync(fullPath, { recursive: true, force: true })
  }
}

// Create a minimal package.json to prevent reinstallation
const cpuFeaturesPath = path.resolve('node_modules/cpu-features')
if (!fs.existsSync(cpuFeaturesPath)) {
  fs.mkdirSync(cpuFeaturesPath, { recursive: true })
  fs.writeFileSync(path.join(cpuFeaturesPath, 'package.json'), JSON.stringify({
    name: 'cpu-features',
    version: '0.0.10',
    main: 'index.js',
    description: 'Stub package to prevent build issues'
  }, null, 2))
  
  fs.writeFileSync(path.join(cpuFeaturesPath, 'index.js'), `
// Stub implementation for cpu-features
module.exports = {
  getX86Info: () => ({ features: {}, family: 0, model: 0, stepping: 0 }),
  getArm64Info: () => ({ features: {} }),
  getArmInfo: () => ({ features: {} })
}
`)
}

console.log('✅ Windows build issues fixed!')
console.log('Now run: npm install --force')
import { DatabaseManager } from './database'

const runMigrations = () => {
  console.log('🔄 Starting database migrations...')
  
  try {
    console.log(`📁 Database path: ${process.env.DB_PATH || 'default'}`)
    
    const db = new DatabaseManager()
    console.log('✅ Migrations completed successfully')
    
    // Run integrity check
    console.log('🔍 Running integrity check...')
    const integrityResult = db['db'].prepare('PRAGMA integrity_check').get() as any
    
    if (integrityResult.integrity_check === 'ok') {
      console.log('✅ Database integrity check passed')
    } else {
      console.error('❌ Database integrity check failed:', integrityResult)
      process.exit(1)
    }
    
    db.close()
    console.log('🏁 Migration process completed')
  } catch (error) {
    console.error('❌ Migration failed:', error)
    process.exit(1)
  }
}

// Check if running as main module
if (require.main === module) {
  runMigrations()
}
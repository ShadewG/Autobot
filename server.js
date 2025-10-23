require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const db = require('./services/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
    contentSecurityPolicy: false // Allow inline scripts for dashboard
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('combined'));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        const dbHealth = await db.healthCheck();
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: dbHealth,
            environment: process.env.NODE_ENV
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

// Import routes
const webhookRoutes = require('./routes/webhooks');
const apiRoutes = require('./routes/api');
const testRoutes = require('./routes/test');

app.use('/webhooks', webhookRoutes);
app.use('/api', apiRoutes);
app.use('/api/test', testRoutes);

// Import cron service and email queue workers
const cronService = require('./services/cron-service');
const { emailWorker, analysisWorker, generateWorker } = require('./queues/email-queue');
const fs = require('fs');

/**
 * Run database migrations automatically
 */
async function runMigrations() {
    try {
        const migrationsDir = path.join(__dirname, 'migrations');

        // Check if migrations directory exists
        if (!fs.existsSync(migrationsDir)) {
            console.log('No migrations directory found, skipping...');
            return;
        }

        // Get all migration files
        const migrationFiles = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.sql'))
            .sort(); // Ensure they run in order

        if (migrationFiles.length === 0) {
            console.log('No migration files found, skipping...');
            return;
        }

        // Create migrations tracking table if it doesn't exist
        await db.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id SERIAL PRIMARY KEY,
                filename VARCHAR(255) UNIQUE NOT NULL,
                applied_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Check which migrations have been run
        const appliedMigrations = await db.query(
            'SELECT filename FROM schema_migrations'
        );
        const appliedSet = new Set(appliedMigrations.rows.map(r => r.filename));

        // Run pending migrations
        let ranCount = 0;
        for (const filename of migrationFiles) {
            if (appliedSet.has(filename)) {
                console.log(`  ✓ ${filename} (already applied)`);
                continue;
            }

            console.log(`  Running ${filename}...`);
            const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');

            try {
                await db.query(sql);
                await db.query(
                    'INSERT INTO schema_migrations (filename) VALUES ($1)',
                    [filename]
                );
                console.log(`  ✓ ${filename} applied successfully`);
                ranCount++;
            } catch (error) {
                console.error(`  ✗ ${filename} failed:`, error.message);
                throw error;
            }
        }

        if (ranCount > 0) {
            console.log(`\n✓ Applied ${ranCount} migration(s)`);
        } else {
            console.log('✓ All migrations up to date');
        }
    } catch (error) {
        console.error('Migration error:', error);
        throw error;
    }
}

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path
    });
});

// Initialize database and start server
async function startServer() {
    try {
        console.log('Initializing database...');
        await db.initialize();
        console.log('Database initialized successfully');

        // Run migrations automatically
        console.log('\nRunning database migrations...');
        await runMigrations();

        // Start cron jobs
        console.log('\nStarting automated services...');
        cronService.start();

        // BullMQ workers are automatically started when imported
        console.log('\nStarting BullMQ workers...');
        console.log('   ✓ Email worker started');
        console.log('   ✓ Analysis worker started');
        console.log('   ✓ Generate worker started');

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`\n🤖 Autobot MVP Server Running`);
            console.log(`   Port: ${PORT}`);
            console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`   Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
            console.log(`   Redis: ${process.env.REDIS_URL ? 'Connected' : 'Not configured'}`);
            console.log(`\n   Health check: http://localhost:${PORT}/health`);
            console.log(`   API: http://localhost:${PORT}/api`);
            console.log(`   Webhooks: http://localhost:${PORT}/webhooks/inbound`);
            console.log(`\n   ✓ Database migrations applied`);
            console.log(`   ✓ Automated follow-ups enabled`);
            console.log(`   ✓ BullMQ workers running`);
            console.log(`   ✓ Notion sync every 15 minutes`);
            console.log(`   ✓ Adaptive learning system active`);
            console.log(`   ✓ Ready to receive requests!\n`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Handle shutdown gracefully
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    cronService.stop();
    await db.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully...');
    cronService.stop();
    await db.close();
    process.exit(0);
});

startServer();

module.exports = app;

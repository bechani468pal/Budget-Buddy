const mysql = require("mysql2");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

const query = (sql, params = []) => new Promise((resolve, reject) => {
    db.query(sql, params, (err, res) => err ? reject(err) : resolve(res));
});

// Helper: check if a column exists in a table
const hasColumn = async (table, column) => {
    const res = await query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [process.env.DB_NAME, table, column]
    );
    return res.length > 0;
};

// Helper: verify if an index is strictly a UNIQUE index on the specified column alone
const isUniqueIndexOnSingleColumn = async (table, indexName, columnName) => {
    const res = await query(
        `SELECT COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX 
         FROM information_schema.STATISTICS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [process.env.DB_NAME, table, indexName]
    );
    // Must be exactly 1 column in the index, matching columnName, and NON_UNIQUE must be 0 (unique)
    return res.length === 1 && res[0].COLUMN_NAME === columnName && res[0].NON_UNIQUE === 0;
};

// Helper: check if an index exists by name
const hasIndex = async (table, indexName) => {
    const res = await query(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [process.env.DB_NAME, table, indexName]
    );
    return res.length > 0;
};

// Helper: check if a foreign key exists by name
const hasForeignKey = async (table, constraintName) => {
    const res = await query(
        `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
        [process.env.DB_NAME, table, constraintName]
    );
    return res.length > 0;
};

db.connect(async (connErr) => {
    if (connErr) {
        console.error("FATAL: Database connection failed:", connErr.message);
        process.exit(1);
    }

    console.log("Connected to MySQL database. Initializing migration...\n");

    const executedSteps = [];

    const runStep = async (stepNumber, stepName, stepFn) => {
        try {
            console.log(`[Step ${stepNumber}] ${stepName}...`);
            const detail = await stepFn();
            executedSteps.push({ stepNumber, name: stepName, status: "SUCCESS", detail: detail || "Completed" });
            console.log(`  ✓ SUCCESS: ${detail || "Completed"}\n`);
        } catch (stepErr) {
            executedSteps.push({ stepNumber, name: stepName, status: "FAILED", error: stepErr.message });
            console.error(`  ✗ FAILED: ${stepErr.message}\n`);
            console.error("=================================================");
            console.error("MIGRATION HALTED DUE TO ERROR.");
            console.error("=================================================");
            console.error("Summary of steps executed before failure:");
            console.table(executedSteps);
            db.end();
            process.exit(1);
        }
    };

    try {
        // Step 1: Pre-flight backup verification
        await runStep(1, "Pre-flight Backup Verification", async () => {
            const backupFiles = fs.readdirSync(__dirname)
                .filter(f => f.startsWith("backup_") && f.endsWith(".json"))
                .sort()
                .reverse();

            if (backupFiles.length === 0) {
                throw new Error("No backup JSON file found in backend directory.");
            }

            const latestBackupPath = path.join(__dirname, backupFiles[0]);
            const backupRaw = fs.readFileSync(latestBackupPath, "utf-8");
            const backupData = JSON.parse(backupRaw);

            const requiredTables = ["users", "transactions", "budgets", "savings_goals"];
            for (const tbl of requiredTables) {
                if (!backupData.tables || !Array.isArray(backupData.tables[tbl])) {
                    throw new Error(`Backup file '${backupFiles[0]}' is missing table '${tbl}'.`);
                }
            }

            return `Verified backup file '${backupFiles[0]}' containing all 4 tables (users: ${backupData.tables.users.length}, transactions: ${backupData.tables.transactions.length}, budgets: ${backupData.tables.budgets.length}, savings_goals: ${backupData.tables.savings_goals.length})`;
        });

        // Step 2: Add role column to users (default 'user', NO admin creation)
        await runStep(2, "Add 'role' column to 'users' table", async () => {
            if (await hasColumn("users", "role")) {
                return "'role' column already exists (no change needed)";
            }
            await query("ALTER TABLE users ADD COLUMN role ENUM('user', 'admin') NOT NULL DEFAULT 'user'");
            return "Added 'role' ENUM('user', 'admin') NOT NULL DEFAULT 'user'";
        });

        // Step 3: Add created_at column to users
        await runStep(3, "Add 'created_at' column to 'users' table", async () => {
            if (await hasColumn("users", "created_at")) {
                return "'created_at' column already exists (no change needed)";
            }
            await query("ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
            return "Added 'created_at' TIMESTAMP DEFAULT CURRENT_TIMESTAMP";
        });

        // Step 4: Add user_id column & FK to transactions (NULLable, no reassignment)
        await runStep(4, "Add 'user_id' column & FK to 'transactions' table", async () => {
            let detail = [];
            if (!(await hasColumn("transactions", "user_id"))) {
                await query("ALTER TABLE transactions ADD COLUMN user_id INT NULL");
                detail.push("Added 'user_id' INT NULL");
            } else {
                detail.push("'user_id' column already exists");
            }

            if (!(await hasForeignKey("transactions", "fk_transactions_user"))) {
                await query("ALTER TABLE transactions ADD CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL");
                detail.push("Added FK fk_transactions_user");
            } else {
                detail.push("FK fk_transactions_user already exists");
            }

            return detail.join(", ");
        });

        // Step 5: Add user_id column & FK to budgets (NULLable, no reassignment)
        await runStep(5, "Add 'user_id' column & FK to 'budgets' table", async () => {
            let detail = [];
            if (!(await hasColumn("budgets", "user_id"))) {
                await query("ALTER TABLE budgets ADD COLUMN user_id INT NULL");
                detail.push("Added 'user_id' INT NULL");
            } else {
                detail.push("'user_id' column already exists");
            }

            if (!(await hasForeignKey("budgets", "fk_budgets_user"))) {
                await query("ALTER TABLE budgets ADD CONSTRAINT fk_budgets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL");
                detail.push("Added FK fk_budgets_user");
            } else {
                detail.push("FK fk_budgets_user already exists");
            }

            return detail.join(", ");
        });

        // Step 6: Verify and replace single-column 'month' UNIQUE index with (user_id, month)
        await runStep(6, "Update 'budgets' unique index to (user_id, month)", async () => {
            let detail = [];
            const isSingleMonthUnique = await isUniqueIndexOnSingleColumn("budgets", "month", "month");

            if (isSingleMonthUnique) {
                await query("ALTER TABLE budgets DROP INDEX month");
                detail.push("Verified and dropped legacy single-column UNIQUE index on 'month'");
            } else if (await hasIndex("budgets", "month")) {
                throw new Error("Index named 'month' exists but is NOT a single-column UNIQUE index on 'month'. Aborting index change for safety.");
            } else {
                detail.push("Single-column 'month' index not present (already removed)");
            }

            if (!(await hasIndex("budgets", "unique_user_month"))) {
                await query("ALTER TABLE budgets ADD UNIQUE KEY unique_user_month (user_id, month)");
                detail.push("Added composite UNIQUE constraint (user_id, month)");
            } else {
                detail.push("Composite UNIQUE constraint (user_id, month) already exists");
            }

            return detail.join(", ");
        });

        // Step 7: Add user_id column & FK to savings_goals (NULLable, no reassignment)
        await runStep(7, "Add 'user_id' column & FK to 'savings_goals' table", async () => {
            let detail = [];
            if (!(await hasColumn("savings_goals", "user_id"))) {
                await query("ALTER TABLE savings_goals ADD COLUMN user_id INT NULL");
                detail.push("Added 'user_id' INT NULL");
            } else {
                detail.push("'user_id' column already exists");
            }

            if (!(await hasForeignKey("savings_goals", "fk_savings_user"))) {
                await query("ALTER TABLE savings_goals ADD CONSTRAINT fk_savings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL");
                detail.push("Added FK fk_savings_user");
            } else {
                detail.push("FK fk_savings_user already exists");
            }

            return detail.join(", ");
        });

        console.log("=================================================");
        console.log("MIGRATION COMPLETED SUCCESSFULLY!");
        console.log("All steps executed without errors.");
        console.log("=================================================");
        console.table(executedSteps);

    } catch (unexpectedErr) {
        console.error("Unexpected error during migration:", unexpectedErr.message);
        db.end();
        process.exit(1);
    } finally {
        db.end();
    }
});

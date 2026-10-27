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

db.connect(async (err) => {
    if (err) {
        console.error("Database connection failed:", err.message);
        process.exit(1);
    }

    const query = (sql, params = []) => new Promise((resolve, reject) => {
        db.query(sql, params, (err, res) => err ? reject(err) : resolve(res));
    });

    try {
        console.log("Connected to MySQL database. Starting backup...");

        const tables = ["users", "transactions", "budgets", "savings_goals"];
        const backupData = {
            timestamp: new Date().toISOString(),
            tables: {}
        };

        for (const tbl of tables) {
            try {
                const rows = await query(`SELECT * FROM \`${tbl}\``);
                backupData.tables[tbl] = rows;
                console.log(`Backed up ${rows.length} rows from table '${tbl}'.`);
            } catch (tblErr) {
                console.warn(`Could not read table '${tbl}':`, tblErr.message);
            }
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupFileName = `backup_${timestamp}.json`;
        const backupFilePath = path.join(__dirname, backupFileName);

        fs.writeFileSync(backupFilePath, JSON.stringify(backupData, null, 2));
        console.log(`\nBackup successfully written to: ${backupFileName}`);

    } catch (e) {
        console.error("Backup failed:", e.message);
    } finally {
        db.end();
    }
});


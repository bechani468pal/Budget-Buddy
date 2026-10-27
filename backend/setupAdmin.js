const mysql = require("mysql2");
const bcrypt = require("bcryptjs");
const readline = require("readline");
require("dotenv").config();

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (q) => new Promise((resolve) => rl.question(q, resolve));

db.connect(async (err) => {
    if (err) {
        console.error("Database connection failed:", err.message);
        process.exit(1);
    }

    const query = (sql, params = []) => new Promise((resolve, reject) => {
        db.query(sql, params, (err, res) => err ? reject(err) : resolve(res));
    });

    try {
        console.log("=== BudgetBuddy Admin Setup ===");
        console.log("This utility allows you to securely configure your administrator account.\n");

        const users = await query("SELECT id, name, email, role FROM users");
        console.log("Currently registered users:");
        if (users.length === 0) {
            console.log("  (No users registered yet)");
        } else {
            users.forEach((u) => {
                console.log(`  [ID: ${u.id}] ${u.name} (${u.email}) - Current Role: ${u.role || 'user'}`);
            });
        }

        console.log("\nOptions:");
        console.log("  1) Promote an existing user to Admin");
        console.log("  2) Create a new Admin account");
        console.log("  3) Exit");

        const choice = (await askQuestion("\nEnter your choice (1-3): ")).trim();

        if (choice === "1") {
            const email = (await askQuestion("Enter the email of the user to make Admin: ")).trim();
            const found = users.find((u) => u.email.toLowerCase() === email.toLowerCase());

            if (!found) {
                console.log(`Error: No user found with email '${email}'.`);
            } else {
                await query("UPDATE users SET role = 'admin' WHERE id = ?", [found.id]);
                console.log(`\n✓ Success! User '${found.name}' (${found.email}) is now an Administrator.`);
            }
        } else if (choice === "2") {
            const name = (await askQuestion("Enter Admin Name: ")).trim();
            const email = (await askQuestion("Enter Admin Email: ")).trim();
            const password = (await askQuestion("Enter Admin Password: ")).trim();

            if (!name || !email || !password) {
                console.log("Error: Name, email, and password cannot be empty.");
            } else {
                const hashedPassword = await bcrypt.hash(password, 10);
                try {
                    const result = await query(
                        "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'admin')",
                        [name, email, hashedPassword]
                    );
                    console.log(`\n✓ Success! Created new Admin account: '${name}' (${email}, ID: ${result.insertId}).`);
                } catch (insertErr) {
                    if (insertErr.code === "ER_DUP_ENTRY") {
                        console.log(`Error: A user with email '${email}' already exists. Use Option 1 to promote them.`);
                    } else {
                        console.log("Error creating admin:", insertErr.message);
                    }
                }
            }
        } else {
            console.log("Exiting without making changes.");
        }

    } catch (e) {
        console.error("Admin setup failed:", e.message);
    } finally {
        rl.close();
        db.end();
    }
});


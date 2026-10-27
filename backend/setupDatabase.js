const mysql = require("mysql2");
require("dotenv").config();

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) {
        console.log("Database connection failed:", err.message);
        return;
    }

    console.log("Connected to MySQL database.");

    const sql = `
        CREATE TABLE IF NOT EXISTS transactions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            description VARCHAR(255) NOT NULL,
            amount DECIMAL(10,2) NOT NULL,
            type ENUM('income', 'expense') NOT NULL,
            category VARCHAR(100) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;

    db.query(sql, (err) => {
        if (err) {
            console.log("Table creation failed:", err.message);
        } else {
            console.log("Transactions table created successfully!");

            const budgetSql = `
                CREATE TABLE IF NOT EXISTS budgets (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    month VARCHAR(7) NOT NULL UNIQUE,
                    amount DECIMAL(10,2) NOT NULL
                )
            `;

            db.query(budgetSql, (err) => {

    if (err) {
        console.log("Budget table creation failed:", err.message);
    } else {
        console.log("Budgets table created successfully!");

        const savingsSql = `
            CREATE TABLE IF NOT EXISTS savings_goals (
                id INT AUTO_INCREMENT PRIMARY KEY,
                goal_name VARCHAR(255) NOT NULL,
                target_amount DECIMAL(10,2) NOT NULL,
                saved_amount DECIMAL(10,2) NOT NULL DEFAULT 0
            )
        `;

        db.query(savingsSql, (err) => {

            if (err) {
                console.log("Savings table creation failed:", err.message);
            } else {
                console.log("Savings goals table created successfully!");
            }

            const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL
    )
`;

db.query(createUsersTable, (err) => {
    if (err) {
        console.log("Error creating users table:", err.message);
    } else {
        console.log("Users table created successfully!");
    }
});
            db.end();
        });
    }
});
            
        }
    });
});
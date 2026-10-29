const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config({ path:"../.env" });
const bcrypt = require("bcryptjs");
const mysql = require("mysql2");
const { generateToken, authenticateToken, requireAdmin } = require("./auth");

const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

db.getConnection((err, connection) => {
    if (err) {
        console.log("MySQL connection failed:", err.message);
    } else {
        console.log("MySQL connected successfully!");
        connection.release();
    }
});

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend assets
app.use(express.static(path.join(__dirname, "../frontend")));

// Server status route (backward compatible)
app.get("/status", (req, res) => {
    res.send("BudgetBuddy Server is Running!");
});

// Helper promise query
const query = (sql, params = []) => new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => err ? reject(err) : resolve(results));
});

// ==========================================
// AUTHENTICATION APIs
// ==========================================

// Register new user (always creates role 'user')
app.post("/api/register", async (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ error: "Name, email, and password are required." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "Please enter a valid email address." });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters long." });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'user')";

        db.query(sql, [name.trim(), email.trim().toLowerCase(), hashedPassword], (err, result) => {
            if (err) {
                if (err.code === "ER_DUP_ENTRY") {
                    return res.status(400).json({ error: "Email is already registered." });
                }
                console.error("Registration database error:", err.message);
                return res.status(500).json({ error: "Failed to register user." });
            }

            const newUser = {
                id: result.insertId,
                name: name.trim(),
                email: email.trim().toLowerCase(),
                role: "user"
            };

            const token = generateToken(newUser);

            res.status(201).json({
                message: "Registration successful",
                token,
                user: newUser
            });
        });

    } catch (error) {
        console.error("Password hashing error:", error.message);
        res.status(500).json({ error: "Registration failed due to server error." });
    }
});

// Login user
app.post("/api/login", (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required." });
    }

    const sql = "SELECT id, name, email, password, role, status FROM users WHERE email = ?";

    db.query(sql, [email.trim().toLowerCase()], async (err, results) => {
        if (err) {
            console.error("Login database error:", err.message);
            return res.status(500).json({ error: "Login failed due to database error." });
        }

        if (results.length === 0) {
            return res.status(401).json({ error: "Invalid email or password." });
        }

        const user = results[0];

        // Check if account is deactivated
        if (user.status === "deactivated") {
            return res.status(403).json({ error: "Your account has been deactivated. Please contact an administrator." });
        }

        const passwordMatch = await bcrypt.compare(password, user.password);

        if (!passwordMatch) {
            return res.status(401).json({ error: "Invalid email or password." });
        }

        const userPayload = {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role || "user",
            status: user.status || "active"
        };

        const token = generateToken(userPayload);

        res.json({
            message: "Login successful",
            token,
            user: userPayload
        });
    });
});

// Verify active session token and return verified user data from DB
app.get("/api/auth/verify", authenticateToken, async (req, res) => {
    try {
        const users = await query("SELECT id, name, email, role, status FROM users WHERE id = ?", [req.user.id]);
        if (users.length === 0) {
            return res.status(401).json({ error: "User account no longer exists." });
        }
        if (users[0].status === "deactivated") {
            return res.status(403).json({ error: "Your account has been deactivated. Please contact support." });
        }
        res.json({
            authenticated: true,
            user: {
                id: users[0].id,
                name: users[0].name,
                email: users[0].email,
                role: users[0].role,
                status: users[0].status
            }
        });
    } catch (err) {
        console.error("Auth verification error:", err.message);
        res.status(500).json({ error: "Failed to verify session." });
    }
});

// ==========================================
// USER PROFILE APIs
// ==========================================

// Get logged-in user profile
app.get("/api/user/profile", authenticateToken, (req, res) => {
    const sql = "SELECT id, name, email, role, created_at FROM users WHERE id = ?";

    db.query(sql, [req.user.id], (err, results) => {
        if (err) {
            console.error("Profile fetch error:", err.message);
            return res.status(500).json({ error: "Failed to fetch profile." });
        }

        if (results.length === 0) {
            return res.status(404).json({ error: "User not found." });
        }

        res.json({ user: results[0] });
    });
});

// Update user profile (name, email, and optionally password)
app.put("/api/user/profile", authenticateToken, async (req, res) => {
    const { name, email, currentPassword, newPassword } = req.body;

    if (!name || !email) {
        return res.status(400).json({ error: "Name and email are required." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "Invalid email format." });
    }

    try {
        // Check if email is used by another user
        const existingEmail = await query("SELECT id FROM users WHERE email = ? AND id != ?", [email.trim().toLowerCase(), req.user.id]);
        if (existingEmail.length > 0) {
            return res.status(400).json({ error: "Email is already taken by another account." });
        }

        // If password update requested
        if (newPassword) {
            if (!currentPassword) {
                return res.status(400).json({ error: "Current password is required to set a new password." });
            }
            if (newPassword.length < 6) {
                return res.status(400).json({ error: "New password must be at least 6 characters long." });
            }

            const userRows = await query("SELECT password FROM users WHERE id = ?", [req.user.id]);
            const passwordValid = await bcrypt.compare(currentPassword, userRows[0].password);
            if (!passwordValid) {
                return res.status(400).json({ error: "Incorrect current password." });
            }

            const hashedNewPassword = await bcrypt.hash(newPassword, 10);
            await query("UPDATE users SET name = ?, email = ?, password = ? WHERE id = ?", [
                name.trim(),
                email.trim().toLowerCase(),
                hashedNewPassword,
                req.user.id
            ]);
        } else {
            // Update name and email only
            await query("UPDATE users SET name = ?, email = ? WHERE id = ?", [
                name.trim(),
                email.trim().toLowerCase(),
                req.user.id
            ]);
        }

        const updatedUser = {
            id: req.user.id,
            name: name.trim(),
            email: email.trim().toLowerCase(),
            role: req.user.role
        };

        const refreshedToken = generateToken(updatedUser);

        res.json({
            message: "Profile updated successfully.",
            token: refreshedToken,
            user: updatedUser
        });

    } catch (err) {
        console.error("Profile update error:", err.message);
        res.status(500).json({ error: "Failed to update profile." });
    }
});

// ==========================================
// TRANSACTIONS APIs (User Isolated)
// ==========================================

// Get transactions for logged-in user only
app.get("/api/transactions", authenticateToken, (req, res) => {
    const sql = "SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC";

    db.query(sql, [req.user.id], (err, results) => {
        if (err) {
            console.error("Error fetching transactions:", err.message);
            return res.status(500).json({ error: "Failed to fetch transactions" });
        }

        res.json(results);
    });
});

// Add new transaction (strictly assigned to req.user.id)
app.post("/api/transactions", authenticateToken, (req, res) => {
    const { description, amount, type, category } = req.body;

    if (!description || !amount || !type || !category) {
        return res.status(400).json({ error: "All transaction fields are required." });
    }

    if (Number(amount) <= 0) {
        return res.status(400).json({ error: "Amount must be greater than zero." });
    }

    if (!["income", "expense"].includes(type)) {
        return res.status(400).json({ error: "Type must be either 'income' or 'expense'." });
    }

    const sql = `
        INSERT INTO transactions (description, amount, type, category, user_id)
        VALUES (?, ?, ?, ?, ?)
    `;

    db.query(sql, [description.trim(), Number(amount), type, category.trim(), req.user.id], (err, result) => {
        if (err) {
            console.error("Error adding transaction:", err.message);
            return res.status(500).json({ error: "Failed to add transaction" });
        }

        res.status(201).json({
            message: "Transaction added successfully",
            id: result.insertId
        });
    });
});

// Update transaction (strictly protected to transaction owner)
app.put("/api/transactions/:id", authenticateToken, (req, res) => {
    const { id } = req.params;
    const { description, amount, type, category } = req.body;

    if (!description || !amount || !type || !category) {
        return res.status(400).json({ error: "All transaction fields are required." });
    }

    const sql = `
        UPDATE transactions
        SET description = ?, amount = ?, type = ?, category = ?
        WHERE id = ? AND user_id = ?
    `;

    db.query(sql, [description.trim(), Number(amount), type, category.trim(), id, req.user.id], (err, result) => {
        if (err) {
            console.error("Error updating transaction:", err.message);
            return res.status(500).json({ error: "Failed to update transaction" });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Transaction not found or unauthorized." });
        }

        res.json({ message: "Transaction updated successfully" });
    });
});

// Delete transaction (strictly protected to transaction owner)
app.delete("/api/transactions/:id", authenticateToken, (req, res) => {
    const { id } = req.params;
    const sql = "DELETE FROM transactions WHERE id = ? AND user_id = ?";

    db.query(sql, [id, req.user.id], (err, result) => {
        if (err) {
            console.error("Error deleting transaction:", err.message);
            return res.status(500).json({ error: "Failed to delete transaction" });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Transaction not found or unauthorized." });
        }

        res.json({ message: "Transaction deleted successfully" });
    });
});

// ==========================================
// BUDGET APIs (User Isolated)
// ==========================================

// Save or update monthly budget for logged-in user
app.post("/api/budget", authenticateToken, (req, res) => {
    const { month, amount } = req.body;

    if (!month || amount === undefined || Number(amount) <= 0) {
        return res.status(400).json({ error: "Valid month (YYYY-MM) and positive amount required." });
    }

    const sql = `
        INSERT INTO budgets (month, amount, user_id)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE amount = VALUES(amount)
    `;

    db.query(sql, [month, Number(amount), req.user.id], (err) => {
        if (err) {
            console.error("Error saving budget:", err.message);
            return res.status(500).json({ error: "Failed to save budget" });
        }

        res.json({ message: "Budget saved successfully" });
    });
});

// Get monthly budget for logged-in user
app.get("/api/budget/:month", authenticateToken, (req, res) => {
    const { month } = req.params;
    const sql = "SELECT * FROM budgets WHERE month = ? AND user_id = ?";

    db.query(sql, [month, req.user.id], (err, results) => {
        if (err) {
            console.error("Error fetching budget:", err.message);
            return res.status(500).json({ error: "Failed to fetch budget" });
        }

        res.json(results);
    });
});

// ==========================================
// SAVINGS GOALS APIs (User Isolated)
// ==========================================

// Save savings goal for logged-in user
app.post("/api/savings", authenticateToken, (req, res) => {
    const { goal_name, target_amount, saved_amount } = req.body;

    if (!goal_name || !target_amount || Number(target_amount) <= 0) {
        return res.status(400).json({ error: "Valid goal name and target amount required." });
    }

    const sql = `
        INSERT INTO savings_goals (goal_name, target_amount, saved_amount, user_id)
        VALUES (?, ?, ?, ?)
    `;

    db.query(sql, [goal_name.trim(), Number(target_amount), Number(saved_amount) || 0, req.user.id], (err, result) => {
        if (err) {
            console.error("Error saving savings goal:", err.message);
            return res.status(500).json({ error: "Failed to save savings goal" });
        }

        res.status(201).json({
            message: "Savings goal saved successfully",
            id: result.insertId
        });
    });
});

// Get savings goals for logged-in user
app.get("/api/savings", authenticateToken, (req, res) => {
    const sql = "SELECT * FROM savings_goals WHERE user_id = ? ORDER BY id DESC";

    db.query(sql, [req.user.id], (err, results) => {
        if (err) {
            console.error("Error fetching savings goals:", err.message);
            return res.status(500).json({ error: "Failed to fetch savings goals" });
        }

        res.json(results);
    });
});

// Update savings goal saved amount
app.put("/api/savings/:id", authenticateToken, (req, res) => {
    const { id } = req.params;
    const { saved_amount } = req.body;

    if (saved_amount === undefined || Number(saved_amount) < 0) {
        return res.status(400).json({ error: "Valid saved amount required." });
    }

    const sql = "UPDATE savings_goals SET saved_amount = ? WHERE id = ? AND user_id = ?";

    db.query(sql, [Number(saved_amount), id, req.user.id], (err, result) => {
        if (err) {
            console.error("Error updating savings goal:", err.message);
            return res.status(500).json({ error: "Failed to update savings goal" });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Savings goal not found or unauthorized." });
        }

        res.json({ message: "Savings goal updated successfully" });
    });
});

// Delete savings goal
app.delete("/api/savings/:id", authenticateToken, (req, res) => {
    const { id } = req.params;
    const sql = "DELETE FROM savings_goals WHERE id = ? AND user_id = ?";

    db.query(sql, [id, req.user.id], (err, result) => {
        if (err) {
            console.error("Error deleting savings goal:", err.message);
            return res.status(500).json({ error: "Failed to delete savings goal" });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Savings goal not found or unauthorized." });
        }

        res.json({ message: "Savings goal deleted successfully" });
    });
});

// ==========================================
// ADMIN APIs (Protected: requireAdmin)
// ==========================================

// Verify administrator authorization against signed token and DB role
app.get("/api/admin/verify", authenticateToken, requireAdmin, async (req, res) => {
    try {
        const users = await query("SELECT id, name, email, role, status FROM users WHERE id = ?", [req.user.id]);
        if (users.length === 0 || users[0].status === "deactivated") {
            return res.status(403).json({ error: "Account inactive or unauthorized." });
        }
        if (users[0].role !== "admin") {
            return res.status(403).json({ error: "Access denied. Administrator privileges required." });
        }
        res.json({
            authorized: true,
            user: {
                id: users[0].id,
                name: users[0].name,
                email: users[0].email,
                role: users[0].role,
                status: users[0].status
            }
        });
    } catch (err) {
        console.error("Admin verify error:", err.message);
        res.status(500).json({ error: "Failed to verify administrator status." });
    }
});

// Create a new user by Administrator
app.post("/api/admin/users", authenticateToken, requireAdmin, async (req, res) => {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ error: "Name, email, and password are required." });
    }

    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();

    if (trimmedName.length < 2) {
        return res.status(400).json({ error: "Full name must be at least 2 characters long." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
        return res.status(400).json({ error: "Please enter a valid email address." });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters long." });
    }

    // Role validation: either 'user' or 'admin', defaults to 'user'
    const assignedRole = (role && ["user", "admin"].includes(String(role).toLowerCase())) 
        ? String(role).toLowerCase() 
        : "user";

    try {
        // Check for existing user with this email
        const existing = await query("SELECT id FROM users WHERE email = ?", [trimmedEmail]);
        if (existing.length > 0) {
            return res.status(400).json({ error: "Email is already registered. Please choose another email." });
        }

        // Hash password securely with bcrypt
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert new user record with active status
        const result = await query(
            "INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, ?, 'active')",
            [trimmedName, trimmedEmail, hashedPassword, assignedRole]
        );

        res.status(201).json({
            message: `User '${trimmedName}' created successfully as ${assignedRole.toUpperCase()}.`,
            user: {
                id: result.insertId,
                name: trimmedName,
                email: trimmedEmail,
                role: assignedRole,
                status: "active"
            }
        });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(400).json({ error: "Email is already registered. Please choose another email." });
        }
        console.error("Admin create user error:", err.message);
        res.status(500).json({ error: "Failed to create user due to server error." });
    }
});

// Get list of all registered users (passwords excluded)
app.get("/api/admin/users", authenticateToken, requireAdmin, async (req, res) => {
    try {
        const users = await query(`
            SELECT id, name, email, role, status, created_at,
                   (SELECT COUNT(*) FROM transactions WHERE user_id = users.id) AS transaction_count
            FROM users 
            ORDER BY id ASC
        `);
        res.json({ users });
    } catch (err) {
        console.error("Admin users fetch error:", err.message);
        res.status(500).json({ error: "Failed to fetch user list." });
    }
});

// Activate or deactivate user account
app.put("/api/admin/users/:id/status", authenticateToken, requireAdmin, async (req, res) => {
    const targetId = parseInt(req.params.id);
    const { status } = req.body;

    if (!status || !["active", "deactivated"].includes(status)) {
        return res.status(400).json({ error: "Invalid status. Must be 'active' or 'deactivated'." });
    }

    if (targetId === req.user.id) {
        return res.status(400).json({ error: "You cannot change the status of your own administrator account." });
    }

    try {
        const existing = await query("SELECT id, name, email, role FROM users WHERE id = ?", [targetId]);
        if (existing.length === 0) {
            return res.status(404).json({ error: "User not found." });
        }

        await query("UPDATE users SET status = ? WHERE id = ?", [status, targetId]);

        res.json({
            message: `User '${existing[0].name}' (${existing[0].email}) status changed to ${status}.`,
            userId: targetId,
            status
        });
    } catch (err) {
        console.error("Admin user status update error:", err.message);
        res.status(500).json({ error: "Failed to update user status." });
    }
});

// View a selected user's account overview and financial summary
app.get("/api/admin/users/:id/overview", authenticateToken, requireAdmin, async (req, res) => {
    const targetId = parseInt(req.params.id);

    try {
        const userRows = await query(
            "SELECT id, name, email, role, status, created_at FROM users WHERE id = ?",
            [targetId]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ error: "User not found." });
        }

        const targetUser = userRows[0];

        // Financial summary for selected user
        const incomeRow = await query(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id = ? AND type = 'income'",
            [targetId]
        );
        const expenseRow = await query(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id = ? AND type = 'expense'",
            [targetId]
        );

        const totalIncome = Number(incomeRow[0].total) || 0;
        const totalExpense = Number(expenseRow[0].total) || 0;
        const balance = totalIncome - totalExpense;

        // Transactions count & recent transactions
        const txCountRow = await query("SELECT COUNT(*) AS total FROM transactions WHERE user_id = ?", [targetId]);
        const recentTx = await query(
            "SELECT id, description, amount, type, category, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10",
            [targetId]
        );

        // Budgets count & list
        const budgetCountRow = await query("SELECT COUNT(*) AS total FROM budgets WHERE user_id = ?", [targetId]);
        const budgets = await query(
            "SELECT id, month, amount FROM budgets WHERE user_id = ? ORDER BY month DESC LIMIT 5",
            [targetId]
        );

        // Savings goals count & list
        const savingsCountRow = await query("SELECT COUNT(*) AS total FROM savings_goals WHERE user_id = ?", [targetId]);
        const savingsGoals = await query(
            "SELECT id, goal_name, target_amount, saved_amount FROM savings_goals WHERE user_id = ? ORDER BY id DESC LIMIT 5",
            [targetId]
        );

        res.json({
            user: targetUser,
            financialSummary: {
                totalIncome,
                totalExpense,
                balance,
                totalTransactions: txCountRow[0].total,
                totalBudgets: budgetCountRow[0].total,
                totalSavingsGoals: savingsCountRow[0].total
            },
            recentTransactions: recentTx,
            budgets,
            savingsGoals
        });

    } catch (err) {
        console.error("Admin user overview error:", err.message);
        res.status(500).json({ error: "Failed to fetch user overview." });
    }
});

// Get system-wide platform statistics
app.get("/api/admin/stats", authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [userCount] = await query("SELECT COUNT(*) AS total FROM users");
        const [activeUsers] = await query("SELECT COUNT(*) AS total FROM users WHERE status = 'active'");
        const [deactivatedUsers] = await query("SELECT COUNT(*) AS total FROM users WHERE status = 'deactivated'");
        const [adminCount] = await query("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'");
        const [txCount] = await query("SELECT COUNT(*) AS total FROM transactions");
        const [budgetCount] = await query("SELECT COUNT(*) AS total FROM budgets");
        const [savingsCount] = await query("SELECT COUNT(*) AS total FROM savings_goals");

        // Safely inspect legacy unassigned records (user_id IS NULL)
        const [legacyTx] = await query("SELECT COUNT(*) AS total FROM transactions WHERE user_id IS NULL");
        const [legacyBudgets] = await query("SELECT COUNT(*) AS total FROM budgets WHERE user_id IS NULL");
        const [legacySavings] = await query("SELECT COUNT(*) AS total FROM savings_goals WHERE user_id IS NULL");

        // Volume breakdown
        const volumeTotals = await query(`
            SELECT type, SUM(amount) AS total 
            FROM transactions 
            GROUP BY type
        `);

        let totalIncome = 0;
        let totalExpense = 0;
        volumeTotals.forEach(v => {
            if (v.type === "income") totalIncome = Number(v.total) || 0;
            if (v.type === "expense") totalExpense = Number(v.total) || 0;
        });

        res.json({
            stats: {
                totalUsers: userCount.total,
                activeUsers: activeUsers.total,
                deactivatedUsers: deactivatedUsers.total,
                adminUsers: adminCount.total,
                totalTransactions: txCount.total,
                totalBudgets: budgetCount.total,
                totalSavingsGoals: savingsCount.total,
                totalVolume: {
                    income: totalIncome,
                    expense: totalExpense
                },
                legacyRecords: {
                    unassignedTransactions: legacyTx.total,
                    unassignedBudgets: legacyBudgets.total,
                    unassignedSavingsGoals: legacySavings.total
                }
            }
        });

    } catch (err) {
        console.error("Admin stats fetch error:", err.message);
        res.status(500).json({ error: "Failed to fetch admin statistics." });
    }
});

// Server port
const PORT = process.env.PORT || 5000;

// Start server
app.listen(PORT, "0.0.0.0", () => {
    console.log(`BudgetBuddy server running on port ${PORT}`);
});

module.exports = app;
const crypto = require("crypto");
require("dotenv").config();

// Use JWT_SECRET from environment or a secure fallback
const JWT_SECRET = process.env.JWT_SECRET || "budgetbuddy_secure_signing_key_college_project_2026";

/**
 * Generate a cryptographically signed HMAC-SHA256 JWT token.
 * Payload includes userId, email, and role.
 */
function generateToken(user) {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
        id: user.id,
        email: user.email,
        role: user.role || "user",
        name: user.name,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hours validity
    })).toString("base64url");

    const signature = crypto
        .createHmac("sha256", JWT_SECRET)
        .update(`${header}.${payload}`)
        .digest("base64url");

    return `${header}.${payload}.${signature}`;
}

/**
 * Verify and decode a JWT token.
 * Returns decoded payload if valid and not expired, otherwise returns null.
 */
function verifyToken(token) {
    if (!token || typeof token !== "string") return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;
    const expectedSignature = crypto
        .createHmac("sha256", JWT_SECRET)
        .update(`${header}.${payload}`)
        .digest("base64url");

    // Timing-safe comparison to prevent timing attacks
    try {
        const sigBuf = Buffer.from(signature);
        const expBuf = Buffer.from(expectedSignature);
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
            return null;
        }

        const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));

        // Expiration check
        if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
            return null; // Token expired
        }

        return decoded;
    } catch {
        return null;
    }
}

/**
 * Express middleware to authenticate requests via Authorization: Bearer <token>.
 * Never trusts user_id or role from req.body or headers; extracts verified identity strictly from token.
 */
function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: "Authentication required. Missing Authorization header." });
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
        return res.status(401).json({ error: "Invalid Authorization format. Expected 'Bearer <token>'." });
    }

    const token = parts[1];
    const user = verifyToken(token);

    if (!user) {
        return res.status(401).json({ error: "Invalid or expired session token. Please log in again." });
    }

    // Attach verified user payload to request
    req.user = user;
    next();
}

/**
 * Express middleware to enforce admin privileges.
 */
function requireAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: "Authentication required." });
    }

    if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Access denied. Administrator privileges required." });
    }

    next();
}

module.exports = {
    generateToken,
    verifyToken,
    authenticateToken,
    requireAdmin
};


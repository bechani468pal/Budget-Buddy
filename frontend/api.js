// BudgetBuddy Shared API and Authentication Helper

// Dynamically determine the backend base URL
const API_BASE = (function () {
    if (window.location.origin && !window.location.origin.startsWith("file:")) {
        // If served from port 5000 (Express), use relative path
        if (window.location.port === "5000") {
            return "";
        }
        // If accessed from another port (e.g., Live Server) on the same host
        return `${window.location.protocol}//${window.location.hostname}:5000`;
    }
    // Fallback for file:// or local environment
    return "http://localhost:5000";
})();

function getAuthToken() {
    return localStorage.getItem("budgetBuddyToken");
}

function getAuthUser() {
    try {
        const raw = localStorage.getItem("budgetBuddyUser");
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function setAuthSession(token, user) {
    if (token) localStorage.setItem("budgetBuddyToken", token);
    if (user) localStorage.setItem("budgetBuddyUser", JSON.stringify(user));
}

function clearAuthSession() {
    localStorage.removeItem("budgetBuddyToken");
    localStorage.removeItem("budgetBuddyUser");
}

function requireAuth() {
    const token = getAuthToken();
    const user = getAuthUser();
    if (!token || !user) {
        clearAuthSession();
        window.location.href = "login.html";
        return null;
    }
    return user;
}

function requireAdminAuth() {
    const user = requireAuth();
    if (!user) return null;
    if (user.role !== "admin") {
        alert("Access denied: Administrator privileges required.");
        window.location.href = "index.html";
        return null;
    }
    return user;
}

async function apiFetch(endpoint, options = {}) {
    options.headers = options.headers || {};
    const token = getAuthToken();
    if (token) {
        options.headers["Authorization"] = `Bearer ${token}`;
    }

    if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(options.body);
    }

    const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;
    const response = await fetch(url, options);

    if (response.status === 401) {
        clearAuthSession();
        window.location.href = "login.html";
        throw new Error("Session expired or unauthorized.");
    }

    return response;
}


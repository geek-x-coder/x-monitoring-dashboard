/**
 * HTTP client (SRP): axios instance, interceptors, retry logic, and URL utilities.
 * All other services depend on this module — not on axios directly (DIP).
 */
import axios from "axios";

export const API_BASE_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:5000";
const API_TIMEOUT_MS = parseInt(import.meta.env.VITE_API_TIMEOUT_MS || "10000");
const RETRY_ATTEMPTS = parseInt(import.meta.env.VITE_RETRY_ATTEMPTS || "3");
const RETRY_DELAY_MS = parseInt(import.meta.env.VITE_RETRY_DELAY_MS || "1000");

const REMEMBERED_API_BASE_URL_KEY = "dashboard_api_base_url";

// ── URL utilities ─────────────────────────────────────────────────────────────

export const normalizeApiBaseUrl = (url) =>
    String(url ?? "")
        .trim()
        .replace(/\/+$/, "");

export const getRememberedApiBaseUrl = () => {
    const fallback = normalizeApiBaseUrl(API_BASE_URL);
    if (typeof window === "undefined") return fallback;
    const stored = localStorage.getItem(REMEMBERED_API_BASE_URL_KEY);
    return normalizeApiBaseUrl(stored || fallback);
};

export const rememberApiBaseUrl = (url) => {
    const normalized = normalizeApiBaseUrl(url || API_BASE_URL);
    if (typeof window !== "undefined" && normalized) {
        localStorage.setItem(REMEMBERED_API_BASE_URL_KEY, normalized);
    }
    return normalized;
};

export const resolveEndpointWithBase = (endpoint, baseUrl = null) => {
    const rawEndpoint = String(endpoint ?? "").trim();
    if (!rawEndpoint) return rawEndpoint;
    if (/^https?:\/\//i.test(rawEndpoint)) return rawEndpoint;

    const normalizedBase = normalizeApiBaseUrl(
        baseUrl || getRememberedApiBaseUrl() || API_BASE_URL,
    );
    if (!normalizedBase) return rawEndpoint;

    return rawEndpoint.startsWith("/")
        ? `${normalizedBase}${rawEndpoint}`
        : `${normalizedBase}/${rawEndpoint.replace(/^\/+/, "")}`;
};

// ── Retry helpers ─────────────────────────────────────────────────────────────

export const isRetryable = (error) => {
    if (!error.response) return true; // network error
    const status = error.response.status;
    return status === 408 || status === 429 || (status >= 500 && status < 600);
};

export const retryWithBackoff = async (config, attempt = 1) => {
    try {
        return await axios.request(config);
    } catch (error) {
        if (attempt < RETRY_ATTEMPTS && isRetryable(error)) {
            const delayMs = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return retryWithBackoff(config, attempt + 1);
        }
        throw error;
    }
};

// ── Error formatting ──────────────────────────────────────────────────────────

export const formatErrorMessage = (error) => {
    if (error?.response) {
        const status = error.response.status;
        const serverMessage = error.response?.data?.message || null;
        const serverDetail = error.response?.data?.detail || null;
        const effectiveMessage =
            status === 500 && serverMessage === "Internal Server Error" && serverDetail
                ? serverDetail
                : serverMessage || serverDetail;
        return effectiveMessage
            ? `HTTP ${status} - ${effectiveMessage}`
            : `Request failed with status code ${status}`;
    }
    if (error?.code === "ECONNABORTED" || error?.message?.includes("timeout")) {
        return "요청 시간이 초과되었습니다 (timeout)";
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
        return "오프라인 상태입니다. 인터넷 연결을 확인하세요.";
    }
    return error?.message || "데이터 로드 실패";
};

// ── Axios instance ────────────────────────────────────────────────────────────

const apiClient = axios.create({
    baseURL: getRememberedApiBaseUrl(),
    timeout: API_TIMEOUT_MS,
    headers: { "Content-Type": "application/json" },
});

apiClient.interceptors.request.use(
    (config) => {
        // Dynamically resolve baseURL so changes via dashboard settings take effect
        config.baseURL = getRememberedApiBaseUrl();
        const token = localStorage.getItem("auth_token");
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
    },
    (error) => Promise.reject(error),
);

apiClient.interceptors.response.use(
    (response) => response,
    (error) => {
        const requestUrl = String(error.config?.url ?? "");
        const isLoginRequest = requestUrl.includes("/auth/login");
        if (error.response?.status === 401 && !isLoginRequest) {
            localStorage.removeItem("auth_token");
            if (window.location.protocol === "file:") {
                window.location.hash = "/login";
            } else {
                window.location.href = "/login";
            }
        }
        return Promise.reject(error);
    },
);

export default apiClient;

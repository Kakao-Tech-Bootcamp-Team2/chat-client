// frontend/services/axios.js
import axios from "axios";
import authService from "./authService";

const API_GATEWAY_URL = process.env.NEXT_PUBLIC_API_GATEWAY_URL;
const CHAT_SERVER_URL = process.env.NEXT_PUBLIC_CHAT_API_URL;

const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 5000,
  backoffFactor: 2,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
  retryableErrors: [
    "ECONNABORTED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "ENETUNREACH",
    "ERR_NETWORK",
  ],
};

const axiosInstance = axios.create({
  timeout: 30000,
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});

// 서버 타입별 baseURL 매핑 함수
function getBaseURLByServerType(serverType) {
  switch (serverType) {
    case "apiGateway":
      return API_GATEWAY_URL;
    case "chatServer":
      return CHAT_SERVER_URL;
    default:
      return API_GATEWAY_URL;
  }
}

// 지수 백오프 딜레이 계산 함수
const getRetryDelay = (retryCount) => {
  const delay =
    RETRY_CONFIG.initialDelayMs *
    Math.pow(RETRY_CONFIG.backoffFactor, retryCount) *
    (1 + Math.random() * 0.1);
  return Math.min(delay, RETRY_CONFIG.maxDelayMs);
};

const isRetryableError = (error) => {
  if (!error) return false;
  if (error.code && RETRY_CONFIG.retryableErrors.includes(error.code)) {
    return true;
  }
  if (
    error.response?.status &&
    RETRY_CONFIG.retryableStatuses.includes(error.response.status)
  ) {
    return true;
  }
  if (!error.response && error.request) {
    return true;
  }
  return false;
};

const pendingRequests = new Map();

axiosInstance.interceptors.request.use(
  async (config) => {
    try {
      // 서버 타입별 baseURL 설정
      if (config.serverType) {
        config.baseURL = getBaseURLByServerType(config.serverType);
      } else {
        config.baseURL = API_GATEWAY_URL;
      }

      if (config.method !== "get" && !config.data) {
        config.data = {};
      }

      const user = authService.getCurrentUser();
      if (user?.token) {
        config.headers["x-auth-token"] = user.token;
        if (user.sessionId) {
          config.headers["x-session-id"] = user.sessionId;
        }
      }

      return config;
    } catch (error) {
      console.error("Request interceptor error:", error);
      return Promise.reject(error);
    }
  },
  (error) => Promise.reject(error)
);

axiosInstance.interceptors.response.use(
  (response) => {
    const requestKey = `${response.config.method}:${response.config.url}`;
    pendingRequests.delete(requestKey);

    return response;
  },
  async (error) => {
    const config = error.config || {};
    config.retryCount = config.retryCount || 0;

    if (axios.isCancel(error)) {
      console.log("Request canceled:", error.message);
      return Promise.reject(error);
    }

    if (
      isRetryableError(error) &&
      config.retryCount < RETRY_CONFIG.maxRetries
    ) {
      config.retryCount++;
      const delay = getRetryDelay(config.retryCount);

      console.log(
        `Retrying request (${config.retryCount}/${RETRY_CONFIG.maxRetries}) ` +
          `after ${Math.round(delay)}ms:`,
        config.url
      );

      try {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return await axiosInstance(config);
      } catch (retryError) {
        if (config.retryCount >= RETRY_CONFIG.maxRetries) {
          console.error("Max retry attempts reached:", config.url);
        }
        return Promise.reject(retryError);
      }
    }

    if (!error.response) {
      const customError = new Error(
        [
          "서버와 통신할 수 없습니다.",
          "네트워크 연결을 확인하고 잠시 후 다시 시도해주세요.",
          error.code ? `(Error: ${error.code})` : "",
        ]
          .filter(Boolean)
          .join(" ")
      );

      customError.isNetworkError = true;
      customError.originalError = error;
      customError.status = 0;
      customError.code = error.code || "NETWORK_ERROR";
      customError.config = config;

      customError.retry = async () => {
        try {
          return await axiosInstance(config);
        } catch (retryError) {
          console.error("Manual retry failed:", retryError);
          throw retryError;
        }
      };

      throw customError;
    }

    const status = error.response.status;
    const errorData = error.response.data;

    let errorMessage;
    let shouldLogout = false;

    switch (status) {
      case 400:
        errorMessage = errorData?.message || "잘못된 요청입니다.";
        break;
      case 401:
        errorMessage = "인증이 필요하거나 만료되었습니다.";
        shouldLogout = true;
        break;
      case 403:
        errorMessage = errorData?.message || "접근 권한이 없습니다.";
        break;
      case 404:
        errorMessage =
          errorData?.message || "요청한 리소스를 찾을 수 없습니다.";
        break;
      case 408:
        errorMessage = "요청 시간이 초과되었습니다.";
        break;
      case 429:
        errorMessage =
          "너무 많은 요청이 발생했습니다. 잠시 후 다시 시도해주세요.";
        break;
      case 500:
        errorMessage = "서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
        break;
      case 502:
      case 503:
      case 504:
        errorMessage =
          "서버가 일시적으로 응답할 수 없습니다. 잠시 후 다시 시도해주세요.";
        break;
      default:
        errorMessage = errorData?.message || "예기치 않은 오류가 발생했습니다.";
    }

    const enhancedError = new Error(errorMessage);
    enhancedError.status = status;
    enhancedError.code = errorData?.code;
    enhancedError.data = errorData;
    enhancedError.config = config;
    enhancedError.originalError = error;
    enhancedError.retry = async () => {
      try {
        return await axiosInstance(config);
      } catch (retryError) {
        console.error("Manual retry failed:", retryError);
        throw retryError;
      }
    };

    if (status === 401) {
      try {
        const refreshed = await authService.refreshToken();
        if (refreshed) {
          const user = authService.getCurrentUser();
          if (user?.token) {
            config.headers["x-auth-token"] = user.token;

            return axiosInstance(config);
          }
        }
      } catch (refreshError) {
        console.error("Token refresh failed:", refreshError);
        authService.logout();
        if (typeof window !== "undefined") {
          window.location.href = "/?error=session_expired";
        }
      }
    }

    throw enhancedError;
  }
);

export default axiosInstance;

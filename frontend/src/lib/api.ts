export const API_URL = (
  import.meta.env.VITE_API_URL || "http://localhost:1337"
).replace(/\/+$/, "");

/** All application API calls must carry the HttpOnly session cookie. */
export function apiFetch(path: `/api/${string}`, options: RequestInit = {}) {
  return fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
  });
}

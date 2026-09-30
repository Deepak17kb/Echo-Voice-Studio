// JSON requests to the local Echo server.

export class ApiError extends Error {
  constructor(message, status, field = null) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

// These routes answer 401 as part of normal sign-in, not because a session expired.
const SIGN_IN_ROUTES = new Set(["/api/auth/login", "/api/auth/register", "/api/auth/me"]);

export async function api(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Echo's local server isn't reachable. Is it still running?", 0);
  }

  if (response.status === 204) return null;
  let result = null;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  if (!response.ok) {
    if (response.status === 401 && !SIGN_IN_ROUTES.has(path)) {
      window.dispatchEvent(new CustomEvent("echo:unauthorized"));
    }
    throw new ApiError(result?.error || "That request didn't quite go through.", response.status, result?.field);
  }
  return result;
}

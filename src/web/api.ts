declare global {
  interface Window {
    __VIOLET_TOKEN__?: string;
  }
}

export const token: string =
  window.__VIOLET_TOKEN__ ?? localStorage.getItem("violetToken") ?? "";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(String((body as { error?: string }).error ?? res.statusText));
  }
  return res.json() as Promise<T>;
}

export const sseUrl = `/api/events?token=${encodeURIComponent(token)}`;


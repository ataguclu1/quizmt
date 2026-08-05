const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export async function apiRequest<T = unknown>(
  path: string,
  options?: RequestInit,
  token?: string
): Promise<T> {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options?.headers || {}),
  };

  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "İstek başarısız oldu.");
  return data as T;
}

export async function login(sicil: string, password?: string) {
  return apiRequest<{ token: string; role: string; adSoyad: string; sicil: string }>(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ sicil, password }) }
  );
}

export async function getUsers(token: string) {
  return apiRequest<{ id: number; sicil: string; adSoyad: string; yetki: string }[]>(
    "/api/users",
    {},
    token
  );
}

export async function addUser(token: string, sicil: string, adSoyad: string, yetki: string) {
  return apiRequest("/api/users", { method: "POST", body: JSON.stringify({ sicil, adSoyad, yetki }) }, token);
}

export async function deleteUser(token: string, sicil: string) {
  return apiRequest(`/api/users/${sicil}`, { method: "DELETE" }, token);
}

export interface QuestionSet {
  id: number;
  name: string;
  questions: Question[];
  createdBy: string | null;
  createdAt: string | null;
}

export interface Question {
  text: string;
  time: number;
  pts: "standard" | "double" | "none";
  answers: { text: string; correct: boolean }[];
}

export async function getQuestionSets(token: string) {
  return apiRequest<QuestionSet[]>("/api/question-sets", {}, token);
}

export async function createQuestionSet(token: string, name: string, questions: Question[]) {
  return apiRequest<QuestionSet>("/api/question-sets", {
    method: "POST",
    body: JSON.stringify({ name, questions }),
  }, token);
}

export async function deleteQuestionSet(token: string, id: number) {
  return apiRequest(`/api/question-sets/${id}`, { method: "DELETE" }, token);
}

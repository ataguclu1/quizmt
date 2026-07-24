import OpenAI from "openai";

function createClient(): OpenAI | null {
  const baseURL =
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1";

  const apiKey =
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  return new OpenAI({ apiKey, baseURL });
}

export const openai = createClient();

const MAX_CHARS = 32000; // ~8000 tokens rough limit

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "placeholder") return null;

  const input = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input,
    }),
  });

  if (!res.ok) {
    console.error("[embeddings] OpenAI API error:", res.status, await res.text());
    return null;
  }

  const json = await res.json();
  return json.data?.[0]?.embedding ?? null;
}

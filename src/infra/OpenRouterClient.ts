const BASE_URL = "https://openrouter.ai/api/v1";

export class OpenRouterClient {
  constructor(private readonly apiKey: string) {}

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request(path, body);
    return res.json() as T;
  }

  async postBinary(path: string, body: unknown): Promise<Buffer> {
    const res = await this.request(path, body);
    return Buffer.from(await res.arrayBuffer());
  }

  private async request(path: string, body: unknown): Promise<Response> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return res;
  }
}

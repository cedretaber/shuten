import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

describe("GET /api/health", () => {
  it("status ok を返し、shared の書記素計数が動く", async () => {
    const app = createApp({ webDistDir: "/nonexistent" });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", graphemeCheck: 1 });
  });
});

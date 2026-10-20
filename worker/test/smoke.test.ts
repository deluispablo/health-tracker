import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("worker", () => {
  it("answers GET / with 404", () => {
    const response = worker.fetch();
    expect(response.status).toBe(404);
  });
});

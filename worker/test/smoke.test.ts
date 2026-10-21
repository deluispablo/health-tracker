import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("worker", () => {
  it("exports fetch and scheduled handlers", () => {
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
  });
});

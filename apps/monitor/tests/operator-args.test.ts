import { expect, test } from "bun:test";
import { parseOperatorArgs } from "../src/operator";

test("operator mail requires an explicit flag on a publishing command", () => {
  expect(parseOperatorArgs(["incident", "resolve", "api-outage"])).toMatchObject({
    notifySubscribers: false,
  });
  expect(parseOperatorArgs(["incident", "resolve", "api-outage", "--notify"])).toEqual({
    kind: "incident",
    action: "resolve",
    slug: "api-outage",
    notifySubscribers: true,
  });
  expect(parseOperatorArgs(["maintenance", "schedule", "--notify"])).toMatchObject({
    kind: "maintenance",
    action: "schedule",
    notifySubscribers: true,
  });
  expect(() => parseOperatorArgs(["incident", "list", "--notify"])).toThrow();
  expect(() => parseOperatorArgs(["incident", "open", "--notify", "--notify"])).toThrow();
});

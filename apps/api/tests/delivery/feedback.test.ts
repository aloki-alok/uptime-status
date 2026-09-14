import { expect, test } from "bun:test";
import { parseSesSuppression } from "../../src/delivery/feedback";

test("SES bounce and complaint events identify only affected recipients", () => {
  expect(
    parseSesSuppression(
      JSON.stringify({
        eventType: "Bounce",
        mail: { destination: ["other@example.com"] },
        bounce: { bouncedRecipients: [{ emailAddress: " Person@Example.com " }] },
      }),
    ),
  ).toEqual({ reason: "bounce", recipients: ["person@example.com"] });
  expect(
    parseSesSuppression(
      JSON.stringify({
        eventType: "Complaint",
        mail: { destination: ["Person@Example.com"] },
        complaint: { complainedRecipients: [{ emailAddress: "person@example.com" }] },
      }),
    ),
  ).toEqual({ reason: "complaint", recipients: ["person@example.com"] });
  expect(parseSesSuppression(JSON.stringify({ eventType: "Delivery" }))).toBeNull();
  expect(() => parseSesSuppression(JSON.stringify({ eventType: "Bounce" }))).toThrow();
});

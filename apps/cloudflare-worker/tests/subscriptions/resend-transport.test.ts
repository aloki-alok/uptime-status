import { describe, expect, test } from "bun:test";
import type { RenderedMail } from "@uptime-status/email";
import {
  createResendTransport,
  MailTransportError,
} from "../../src/subscriptions/resend-transport";

const mail: RenderedMail = {
  messageId: "example-site:confirm-001:confirmation",
  category: "confirmation",
  from: { name: 'Example "status"', email: "status@example.com" },
  replyTo: "support@example.com",
  to: "person@example.com",
  subject: "Confirm status updates",
  text: "Confirm using the private link.",
  html: '<p>Confirm using the private link.</p><img src="cid:site-logo">',
  headers: { "X-Status-Event": "confirm-001" },
  attachments: [{ contentId: "site-logo", path: "./assets/logo.svg", alt: "Example" }],
};

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Resend mail transport", () => {
  test("maps rendered mail to the Resend HTTP contract", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const transport = createResendTransport({
      apiKey: "re_test_key",
      userAgent: "uptime-status-tests/1.0",
      resolveAttachmentPath: (path) => {
        expect(path).toBe("./assets/logo.svg");
        return "https://status.example.com/site-assets/logo.svg";
      },
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return response(200, { id: "provider-message-001" });
      },
    });

    await expect(transport.send(mail)).resolves.toEqual({
      providerMessageId: "provider-message-001",
    });
    expect(capturedUrl).toBe("https://api.resend.com/emails");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.redirect).toBe("error");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer re_test_key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe(mail.messageId);
    expect(headers.get("user-agent")).toBe("uptime-status-tests/1.0");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      from: '"Example \\"status\\"" <status@example.com>',
      to: ["person@example.com"],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: mail.headers,
      reply_to: "support@example.com",
      attachments: [
        {
          path: "https://status.example.com/site-assets/logo.svg",
          filename: "logo.svg",
          content_id: "site-logo",
        },
      ],
    });
  });

  test("omits optional fields from plain rendered mail", async () => {
    let body: Record<string, unknown> = {};
    const transport = createResendTransport({
      apiKey: "re_test_key",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return response(200, { id: "provider-message-002" });
      },
    });

    await transport.send({ ...mail, replyTo: undefined, attachments: [] });
    expect(body.reply_to).toBeUndefined();
    expect(body.attachments).toBeUndefined();
  });

  test("classifies rate limits and server failures as retryable", async () => {
    for (const status of [429, 500, 503]) {
      const transport = createResendTransport({
        apiKey: "re_test_key",
        fetch: async () => response(status, { message: "person@example.com secret.token" }),
      });

      try {
        await transport.send({ ...mail, attachments: [] });
        throw new Error("Expected delivery to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(MailTransportError);
        expect((error as MailTransportError).retryable).toBe(true);
        expect((error as MailTransportError).status).toBe(status);
        expect((error as Error).message).not.toContain("person@example.com");
        expect((error as Error).message).not.toContain("secret.token");
      }
    }
  });

  test("classifies other client failures as permanent without exposing the response", async () => {
    for (const status of [400, 401, 403, 422, 451]) {
      const transport = createResendTransport({
        apiKey: "re_test_key",
        fetch: async () => response(status, { message: "person@example.com secret.token" }),
      });

      try {
        await transport.send({ ...mail, attachments: [] });
        throw new Error("Expected delivery to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(MailTransportError);
        expect((error as MailTransportError).retryable).toBe(false);
        expect((error as MailTransportError).status).toBe(status);
        expect((error as Error).message).toBe("Resend rejected the delivery request");
      }
    }
  });

  test("treats network and malformed success responses as retryable", async () => {
    const networkFailure = createResendTransport({
      apiKey: "re_test_key",
      fetch: async () => {
        throw new TypeError("person@example.com secret.token");
      },
    });
    await expect(networkFailure.send({ ...mail, attachments: [] })).rejects.toMatchObject({
      message: "Resend could not be reached",
      retryable: true,
    });

    for (const body of [{}, { id: "" }, { id: 42 }, "not-an-object"]) {
      const malformed = createResendTransport({
        apiKey: "re_test_key",
        fetch: async () => response(200, body),
      });
      await expect(malformed.send({ ...mail, attachments: [] })).rejects.toMatchObject({
        message: "Resend returned an invalid success response",
        retryable: true,
        status: 200,
      });
    }
  });

  test("refuses unresolved or unsafe CID attachment paths before sending", async () => {
    let requests = 0;
    const fetcher: typeof globalThis.fetch = async () => {
      requests += 1;
      return response(200, { id: "unexpected" });
    };
    const unresolved = createResendTransport({ apiKey: "re_test_key", fetch: fetcher });
    await expect(unresolved.send(mail)).rejects.toMatchObject({
      message: "A rendered attachment path could not be resolved to HTTPS",
      retryable: false,
    });
    const insecure = createResendTransport({
      apiKey: "re_test_key",
      fetch: fetcher,
      resolveAttachmentPath: () => "http://status.example.com/logo.svg",
    });
    await expect(insecure.send(mail)).rejects.toMatchObject({
      message: "A rendered attachment path could not be resolved to HTTPS",
      retryable: false,
    });
    const failedResolver = createResendTransport({
      apiKey: "re_test_key",
      fetch: fetcher,
      resolveAttachmentPath: () => {
        throw new Error("./assets/logo.svg person@example.com");
      },
    });
    await expect(failedResolver.send(mail)).rejects.toMatchObject({
      message: "A rendered attachment path could not be resolved to HTTPS",
      retryable: false,
    });
    expect(requests).toBe(0);
  });

  test("does not log delivery content or provider errors", async () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.log = (...values) => calls.push(values);
    console.warn = (...values) => calls.push(values);
    console.error = (...values) => calls.push(values);
    try {
      const transport = createResendTransport({
        apiKey: "re_test_key",
        fetch: async () => response(400, { message: "person@example.com secret.token" }),
      });
      await expect(transport.send({ ...mail, attachments: [] })).rejects.toBeInstanceOf(
        MailTransportError,
      );
      expect(calls).toEqual([]);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
  });
});

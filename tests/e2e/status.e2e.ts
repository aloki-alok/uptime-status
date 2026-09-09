import { expect, test } from "@playwright/test";

test.describe("status overview", () => {
  for (const route of ["/v/1/", "/v/2/", "/v/3/"]) {
    test(`${route} renders meaningful status and complete history`, async ({ page }) => {
      await page.goto(route);

      await expect(page.getByRole("heading", { level: 1 })).toHaveText("All systems operational");
      await expect(page.getByRole("heading", { name: "Service health" })).toBeVisible();
      await expect(page.locator(".uptime-day")).toHaveCount(180);
      await expect(page.locator(".site-header img")).toHaveCount(0);
      await expect(page.locator(".latency-card svg[role='img']")).toHaveCount(1);
      await expect(page.getByText("Infrastructure capacity update")).toBeVisible();
    });
  }

  test("subscription preview uses native dialog behavior", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Subscribe to status updates" }).click();

    const dialog = page.getByRole("dialog", { name: "Get status updates" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Email address")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Subscribe to status updates" })).toBeFocused();
  });

  test("public header keeps only primary actions", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator(".site-header img")).toHaveCount(0);
    await expect(page.getByRole("navigation").getByRole("link")).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Past incidents" })).toBeVisible();
    await expect(page.locator(".community-link")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Planned work" })).toHaveCount(0);
    await expect(page.locator(".state-meta")).toHaveCount(0);
  });

  test("uptime history exposes only the three public status categories", async ({ page }) => {
    await page.goto("/");

    const legend = page.getByLabel("Uptime history legend");
    await expect(legend.locator("span")).toHaveCount(3);
    await expect(legend).toContainText("Operational");
    await expect(legend).toContainText("Maintenance");
    await expect(legend).toContainText("Outage");
    await expect(legend).not.toContainText("Degraded");
    await expect(legend).not.toContainText("No data");
  });

  test("status surfaces and monitor sections use the same width", async ({ page }) => {
    await page.goto("/");

    const edges = await page
      .locator(".state-hero, .maintenance-callout, .component-groups, .latency-grid")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return [Math.round(box.left), Math.round(box.right)];
        }),
      );

    expect(new Set(edges.map((edge) => JSON.stringify(edge))).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
      await page.evaluate(() => window.innerWidth),
    );
  });

  test("scheduled maintenance uses a quiet row instead of a side-accent card", async ({ page }) => {
    await page.goto("/");

    const maintenance = page.locator(".maintenance-callout");
    await expect(maintenance.getByRole("link", { name: /View .* details/ })).toHaveText(
      "View details",
    );
    await expect(maintenance).toHaveCSS("box-shadow", "none");
    expect(
      await maintenance.evaluate((element) => getComputedStyle(element).backgroundColor),
    ).not.toBe("rgba(0, 0, 0, 0)");
  });
});

test("maintenance and history routes expose operational detail", async ({ page }) => {
  await page.goto("/maintenance/");
  await expect(page.getByRole("heading", { level: 1, name: "Planned maintenance" })).toBeVisible();
  await expect(page.getByText("UTC", { exact: true })).toBeVisible();

  await page.goto("/history/");
  await expect(page.getByRole("heading", { level: 1, name: "Past incidents" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Elevated API latency" })).toHaveAttribute(
    "href",
    "/incidents/elevated-api-latency/",
  );
});

test("incident detail route exposes the complete response log", async ({ page }) => {
  await page.goto("/incidents/elevated-api-latency/");
  await expect(page.getByRole("heading", { level: 1, name: "Elevated API latency" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Incident updates" })).toBeVisible();
  await expect(page.locator(".incident-timeline li")).toHaveCount(4);
  await expect(page.getByText("Next update by")).toHaveCount(0);

  const missingIncident = await page.goto("/incidents/not-a-real-incident/");
  expect(missingIncident?.status()).toBe(404);
});

test("subscription outcome routes remain clear without client JavaScript", async ({ page }) => {
  const outcomes = [
    ["confirmed", "Subscription confirmed"],
    ["expired", "Confirmation link expired"],
    ["invalid", "Confirmation link unavailable"],
    ["unsubscribe", "Stop status emails?"],
    ["unsubscribed", "Status emails stopped"],
    ["unsubscribe-invalid", "Unsubscribe link unavailable"],
  ] as const;
  for (const [route, heading] of outcomes) {
    await page.goto(`/subscriptions/${route}/`);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("link", { name: "Return to current status" })).toHaveAttribute(
      "href",
      "/",
    );
  }
});

test("stale and nullable observations never render as healthy or malformed", async ({ page }) => {
  await page.goto("/v/stale/");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Status data is delayed");
  await expect(page.getByText("Response unavailable", { exact: true })).toBeVisible();
  await expect(page.locator(".uptime-day.day-unknown")).toHaveCount(1);
  await expect(page.getByText("null%", { exact: false })).toHaveCount(0);
  await expect(page.locator(".uptime-day[tabindex]")).toHaveCount(0);
});

test("core status content is present in the server response", async ({ request }) => {
  const response = await request.get("/");
  const html = await response.text();

  expect(response.ok()).toBe(true);
  expect(html).toContain("All systems operational");
  expect(html).toContain("Service health");
  expect(html).toContain("Public API");
  expect(html).not.toContain("Customer surfaces");
  expect(html).not.toContain("Core platform");
});

test("a validated live snapshot updates response values and chart points", async ({
  page,
  request,
}) => {
  const snapshot = await (await request.get("/current.json")).json();
  const now = new Date(Date.now() + 30_000).toISOString();
  snapshot.generatedAt = now;
  snapshot.latestCheckAt = now;
  snapshot.sourceRevision = "live-refresh-test-0001";
  snapshot.components[0].responseTimeMs = 321;
  snapshot.components[0].latency.at(-1).avgMs = 333;
  snapshot.components[0].latency.at(-1).p95Ms = 411;

  await page.route("**/current.json", (route) => route.fulfill({ json: snapshot }));
  await page.goto("/");

  await expect(page.getByText("321 ms response", { exact: true })).toBeVisible();
  const apiLatency = page.locator('[data-latency-slug="public-api"]');
  await expect(apiLatency.locator("[data-latency-now]")).toHaveText("333 ms");
  await expect(apiLatency.locator("[data-latency-p95]")).toHaveText("411 ms");
  await expect(page.locator("[data-status-root]")).toHaveAttribute(
    "data-source-revision",
    "live-refresh-test-0001",
  );
});

test("status border and maintenance label keep distinct semantic colors", async ({
  page,
  request,
}) => {
  const snapshot = await (await request.get("/current.json")).json();
  const now = new Date(Date.now() + 30_000).toISOString();
  snapshot.generatedAt = now;
  snapshot.latestCheckAt = now;
  snapshot.sourceRevision = "semantic-color-test-0001";
  snapshot.components[0].state = "degraded";

  await page.route("**/current.json", (route) => route.fulfill({ json: snapshot }));
  await page.goto("/v/1/");

  const colors = await page.evaluate(() => {
    const status = document.querySelector("[data-state-banner]");
    const maintenance = document.querySelector(".maintenance-callout");
    if (!status || !maintenance) throw new Error("Expected semantic banners");
    return {
      status: getComputedStyle(status).borderTopColor,
      maintenance: getComputedStyle(maintenance.querySelector(".eyebrow")).color,
    };
  });
  expect(colors.status).not.toBe(colors.maintenance);
  await expect(page.locator("[data-state-banner]")).toHaveClass(/state-degraded/);
  await expect(page.locator(".status-dot")).toHaveCount(0);
});

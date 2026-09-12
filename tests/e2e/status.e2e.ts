import { expect, test } from "@playwright/test";

test.describe("status overview", () => {
  for (const route of ["/v/1/", "/v/2/", "/v/3/"]) {
    test(`${route} renders meaningful status and complete history`, async ({ page }) => {
      await page.goto(route);

      await expect(page.getByRole("heading", { level: 1 })).toHaveText("All systems operational");
      await expect(page.getByRole("heading", { name: "Service health" })).toBeVisible();
      await expect(page.locator(".uptime-day")).toHaveCount(180);
      await expect(page.locator(".site-brand img")).toHaveCount(1);
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

    await expect(page.getByRole("link", { name: "Example Service home" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    await expect(page.locator(".site-brand img")).toHaveAttribute("src", /^data:image\//);
    expect(
      await page
        .locator(".site-brand img")
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    ).toBe(true);
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
    "/incidents/?id=elevated-api-latency",
  );
});

test("newly published notices appear without rebuilding the static site", async ({
  page,
  request,
}) => {
  const original = await request.get("/current.json");
  const snapshot = await original.json();
  const startedAt = snapshot.generatedAt;
  const incident = {
    slug: "new-api-incident",
    revision: 1,
    title: "New API incident",
    state: "investigating",
    impact: "degraded",
    affectedComponents: [snapshot.components[0].slug],
    startedAt,
    updates: [
      {
        id: "new-update",
        state: "investigating",
        message: "We are checking slow requests.",
        publishedAt: startedAt,
      },
    ],
  };
  snapshot.activeIncidents = [incident, ...snapshot.activeIncidents];
  await page.route("**/current.json", (route) => route.fulfill({ json: snapshot }));

  await page.goto("/history/");
  const link = page.getByRole("link", { name: "New API incident" });
  await expect(link).toHaveAttribute("href", "/incidents/?id=new-api-incident");
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: "New API incident" })).toBeVisible();
  await expect(page.getByText("We are checking slow requests.")).toBeVisible();
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
  await expect(page.locator("[data-component-history]")).toHaveCount(2);
  await expect(page.locator("[data-component-history][role='group']")).toHaveCount(2);
  await expect(page.locator("[data-component-history] .uptime-day[tabindex='0']")).toHaveCount(2);

  const unknown = page.locator(".uptime-day.day-unknown");
  await unknown.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("No uptime data");
  await expect(tooltip).toContainText("Status delayed");
  await expect(tooltip).not.toContainText("null%");
});

test("uptime history supports pointer and keyboard day details", async ({ page }) => {
  await page.goto("/");

  const history = page.locator("[data-component-history]").first();
  const days = history.locator(".uptime-day");
  await expect(days).toHaveCount(90);
  await expect(history.locator(".uptime-day[tabindex='0']")).toHaveCount(1);

  await history.locator(".uptime-day[tabindex='0']").focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(history.locator(".uptime-day:focus")).toHaveAttribute("tabindex", "0");
  await page.keyboard.press("Home");
  await expect(days.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(days.last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
});

test("core status content is present in the server response", async ({ request }) => {
  const response = await request.get("/");
  const html = await response.text();

  expect(response.ok()).toBe(true);
  expect(html).toContain('rel="icon" href="data:image/');
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
  snapshot.components[0].latency.at(-1).sampleCount = 4;
  const expectedChecks = snapshot.components[0].latency.reduce(
    (sum: number, point: { sampleCount: number }) => sum + point.sampleCount,
    0,
  );
  const expectedAverage = Math.round(
    snapshot.components[0].latency.reduce(
      (sum: number, point: { avgMs: number; sampleCount: number }) =>
        sum + point.avgMs * point.sampleCount,
      0,
    ) / expectedChecks,
  );

  await page.route("**/current.json", (route) => route.fulfill({ json: snapshot }));
  await page.goto("/");

  await expect(page.getByText("321 ms response", { exact: true })).toBeVisible();
  const apiLatency = page.locator('[data-latency-slug="public-api"]');
  await expect(apiLatency.locator("[data-latency-now]")).toHaveText("333 ms");
  await expect(apiLatency.locator("[data-latency-count]")).toHaveText(String(expectedChecks));
  await expect(apiLatency.locator("[data-latency-average]")).toHaveText(`${expectedAverage} ms`);
  await apiLatency.locator("[data-latency-interaction]").focus();
  await expect(apiLatency.locator("[data-latency-tooltip]")).toBeVisible();
  await expect(apiLatency.locator("[data-latency-tooltip-value]")).toHaveText("333 ms");
  await expect(apiLatency.getByText("Latest p95", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-status-root]")).toHaveAttribute(
    "data-source-revision",
    "live-refresh-test-0001",
  );
});

test("latency charts expose exact samples to pointer and keyboard users", async ({
  page,
}, testInfo) => {
  await page.goto("/");

  const card = page.locator("[data-latency-slug]").first();
  const interaction = card.locator("[data-latency-interaction]");
  const tooltip = card.locator("[data-latency-tooltip]");
  const announcement = card.locator("[data-latency-announcement]");
  const points = JSON.parse((await interaction.getAttribute("data-chart-points")) ?? "[]");
  const latest = points.at(-1);
  const previous = points.at(-2);

  await interaction.focus();
  await expect(tooltip).toBeVisible();
  await expect(interaction).toHaveAttribute("data-selected-at", latest.observedAt);
  await expect(card.locator("[data-latency-tooltip-value]")).toHaveText(`${latest.avgMs} ms`);
  await expect(card.locator("[data-latency-tooltip-samples]")).toContainText("1 check");
  await expect(announcement).toContainText(`${latest.avgMs} ms`);
  await expect(announcement).toHaveCSS("clip-path", "inset(50%)");
  const announcementBox = await announcement.boundingBox();
  expect(announcementBox?.width).toBeLessThanOrEqual(1);
  expect(announcementBox?.height).toBeLessThanOrEqual(1);

  await page.keyboard.press("ArrowLeft");
  await expect(interaction).toHaveAttribute("data-selected-at", previous.observedAt);
  await expect(announcement).toContainText(`${previous.avgMs} ms`);
  await page.keyboard.press("End");
  await expect(interaction).toHaveAttribute("data-selected-at", latest.observedAt);
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();

  const box = await interaction.boundingBox();
  if (!box) throw new Error("Expected a measurable latency chart");
  if (testInfo.project.name !== "mobile-chromium") {
    await interaction.hover({ position: { x: 2, y: box.height / 2 } });
    await expect(tooltip).toBeVisible();
    await expect(interaction).toHaveAttribute("data-selected-at", points[0].observedAt);
    await page.mouse.move(box.x - 10, box.y - 10);
    await expect(tooltip).toBeHidden();
  }

  if (testInfo.project.name === "mobile-chromium")
    await interaction.tap({ position: { x: 2, y: box.height / 2 } });
  else await interaction.hover({ position: { x: 2, y: box.height / 2 } });
  await expect(tooltip).toBeVisible();
  await interaction.dispatchEvent("pointercancel", { pointerType: "touch" });
  await expect(tooltip).toBeHidden();

  await interaction.evaluate((element: HTMLButtonElement) => element.blur());
  await interaction.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(tooltip).toBeHidden();

  if (testInfo.project.name === "mobile-chromium")
    await interaction.tap({ position: { x: 2, y: box.height / 2 } });
  else await interaction.hover({ position: { x: 2, y: box.height / 2 } });
  await expect(tooltip).toBeVisible();
  const tooltipBox = await tooltip.boundingBox();
  if (!tooltipBox) throw new Error("Expected a measurable latency tooltip");
  expect(tooltipBox.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth),
  );
  await page.locator("[data-state-banner]").click();
  await expect(tooltip).toBeHidden();
});

test("latency charts leave missing minute buckets visibly disconnected", async ({
  page,
  request,
}) => {
  const snapshot = await (await request.get("/current.json")).json();
  const now = new Date(Date.now() + 30_000).toISOString();
  snapshot.generatedAt = now;
  snapshot.latestCheckAt = now;
  snapshot.sourceRevision = "latency-gap-test-0001";
  snapshot.components[0].latency.splice(30, 1);

  await page.route("**/current.json", (route) => route.fulfill({ json: snapshot }));
  await page.goto("/");

  const card = page.locator('[data-latency-slug="public-api"]');
  await expect(card.locator("[data-chart-segment]")).toHaveCount(2);
});

test("a single latency point replaces older geometry and remains inspectable", async ({
  page,
  request,
}) => {
  const snapshot = await (await request.get("/current.json")).json();
  const now = new Date(Date.now() + 30_000).toISOString();
  const point = { ...snapshot.components[0].latency.at(-1), avgMs: 287, sampleCount: 3 };
  snapshot.generatedAt = now;
  snapshot.latestCheckAt = now;
  snapshot.sourceRevision = "single-latency-point-test-0001";
  snapshot.components[0].latestObservedAt = now;
  snapshot.components[0].latency = [point];

  await page.route("**/current.json", (route) => route.fulfill({ json: snapshot }));
  await page.goto("/");

  const card = page.locator('[data-latency-slug="public-api"]');
  await expect(card.locator("[data-chart-segment]")).toHaveCount(1);
  await expect(card.locator(".chart-sample")).toHaveCount(1);
  await expect(card.locator("[data-latency-count]")).toHaveText("3");
  await card.locator("[data-latency-interaction]").focus();
  await expect(card.locator("[data-latency-tooltip-value]")).toHaveText("287 ms");
  await expect(card.locator("[data-latency-tooltip-samples]")).toHaveText("3 checks");
});

test("latency summaries exclude valid observations outside the latest 60-minute window", async ({
  page,
  request,
}) => {
  const snapshot = await (await request.get("/current.json")).json();
  const latency = snapshot.components[0].latency;
  const latestObservedAt = snapshot.components[0].latestObservedAt;
  const endBucket = Math.floor(Date.parse(latestObservedAt) / 60_000) * 60_000;
  const windowStart = endBucket - 59 * 60_000;
  const visible = latency.filter(
    (point: { observedAt: string }) =>
      Date.parse(point.observedAt) >= windowStart &&
      Date.parse(point.observedAt) <= Date.parse(latestObservedAt),
  );
  const oldPoint = {
    observedAt: new Date(windowStart - 60_000).toISOString(),
    avgMs: 999,
    sampleCount: 50,
  };
  snapshot.sourceRevision = "latency-window-test-0001";
  snapshot.components[0].latency = [oldPoint, ...latency];

  await page.route("**/current.json", (route) => route.fulfill({ json: snapshot }));
  await page.goto("/");

  const card = page.locator('[data-latency-slug="public-api"]');
  const interaction = card.locator("[data-latency-interaction]");
  const renderedPoints = JSON.parse((await interaction.getAttribute("data-chart-points")) ?? "[]");
  const expectedChecks = visible.reduce(
    (sum: number, point: { sampleCount: number }) => sum + point.sampleCount,
    0,
  );
  expect(renderedPoints).toHaveLength(visible.length);
  expect(renderedPoints).not.toContainEqual(expect.objectContaining({ avgMs: 999 }));
  await expect(card.locator("[data-latency-count]")).toHaveText(String(expectedChecks));
});

test("an invalid latency sequence cannot replace the last valid graph", async ({
  page,
  request,
}) => {
  const initial = await (await request.get("/current.json")).json();
  const invalid = structuredClone(initial);
  invalid.generatedAt = new Date(Date.now() + 30_000).toISOString();
  invalid.latestCheckAt = invalid.generatedAt;
  invalid.sourceRevision = "invalid-latency-order-test-0001";
  invalid.components[0].latency[1].observedAt = invalid.components[0].latency[0].observedAt;
  invalid.components[0].latency.at(-1).avgMs = 999;

  await page.route("**/current.json", (route) => route.fulfill({ json: invalid }));
  await page.goto("/");

  const root = page.locator("[data-status-root]");
  const card = page.locator('[data-latency-slug="public-api"]');
  await expect(root).not.toHaveAttribute("data-source-revision", invalid.sourceRevision);
  await expect(card.locator("[data-latency-now]")).not.toHaveText("999 ms");
});

test("latency payloads reject future component observations and unbounded series", async ({
  page,
  request,
}) => {
  const initial = await (await request.get("/current.json")).json();
  const afterLatest = structuredClone(initial);
  const latestObservedAt = Date.parse(afterLatest.components[0].latestObservedAt);
  afterLatest.generatedAt = new Date(latestObservedAt + 2_000).toISOString();
  afterLatest.latestCheckAt = afterLatest.generatedAt;
  afterLatest.sourceRevision = "latency-after-component-test-0001";
  afterLatest.components[0].latency.at(-1).observedAt = new Date(
    latestObservedAt + 1_000,
  ).toISOString();

  const oversized = structuredClone(initial);
  const now = Date.now() + 30_000;
  oversized.generatedAt = new Date(now).toISOString();
  oversized.latestCheckAt = oversized.generatedAt;
  oversized.sourceRevision = "latency-series-limit-test-0001";
  oversized.components[0].latestObservedAt = oversized.generatedAt;
  const template = oversized.components[0].latency.at(-1);
  oversized.components[0].latency = Array.from({ length: 121 }, (_, index) => ({
    ...template,
    observedAt: new Date(now - (120 - index) * 1_000).toISOString(),
  }));

  for (const invalid of [afterLatest, oversized]) {
    await page.unrouteAll({ behavior: "wait" });
    await page.route("**/current.json", (route) => route.fulfill({ json: invalid }));
    await page.goto("/");
    await expect(page.locator("[data-status-root]")).not.toHaveAttribute(
      "data-source-revision",
      invalid.sourceRevision,
    );
  }
});

test("live latency refresh keeps, replaces, clears, and restores graph selection safely", async ({
  page,
  request,
}) => {
  let live = await (await request.get("/current.json")).json();
  live.sourceRevision = "latency-selection-initial-0001";
  await page.route("**/current.json", (route) => route.fulfill({ json: live }));
  await page.goto("/");

  const root = page.locator("[data-status-root]");
  const card = page.locator('[data-latency-slug="public-api"]');
  const interaction = card.locator("[data-latency-interaction]");
  const tooltip = card.locator("[data-latency-tooltip]");
  const announcement = card.locator("[data-latency-announcement]");
  await expect(root).toHaveAttribute("data-source-revision", live.sourceRevision);
  await interaction.focus();
  await page.keyboard.press("ArrowLeft");
  const selectedAt = await interaction.getAttribute("data-selected-at");
  if (!selectedAt) throw new Error("Expected a selected latency observation");

  const retained = structuredClone(live);
  retained.sourceRevision = "latency-selection-retained-0002";
  const retainedPoint = retained.components[0].latency.find(
    (point: { observedAt: string }) => point.observedAt === selectedAt,
  );
  if (!retainedPoint) throw new Error("Expected the selected observation in the next revision");
  retainedPoint.avgMs = 444;
  live = retained;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(root).toHaveAttribute("data-source-revision", retained.sourceRevision);
  await expect(interaction).toHaveAttribute("data-selected-at", selectedAt);
  await expect(card.locator("[data-latency-tooltip-value]")).toHaveText("444 ms");

  const removed = structuredClone(retained);
  removed.sourceRevision = "latency-selection-replaced-0003";
  removed.components[0].latency = removed.components[0].latency.filter(
    (point: { observedAt: string }) => point.observedAt !== selectedAt,
  );
  const replacement = removed.components[0].latency.at(-1);
  live = removed;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(root).toHaveAttribute("data-source-revision", removed.sourceRevision);
  await expect(interaction).toHaveAttribute("data-selected-at", replacement.observedAt);
  await expect(announcement).toContainText(`${replacement.avgMs} ms`);

  const empty = structuredClone(removed);
  empty.sourceRevision = "latency-selection-empty-0004";
  empty.components[0].latency = [
    {
      observedAt: new Date(
        Date.parse(empty.components[0].latestObservedAt) - 61 * 60_000,
      ).toISOString(),
      avgMs: 90,
      sampleCount: 1,
    },
  ];
  live = empty;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(root).toHaveAttribute("data-source-revision", empty.sourceRevision);
  await expect(card).toBeHidden();
  await expect(tooltip).toBeHidden();
  await expect(interaction).not.toHaveAttribute("data-selected-at", /.+/);

  const restored = structuredClone(removed);
  restored.sourceRevision = "latency-selection-restored-0005";
  live = restored;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(root).toHaveAttribute("data-source-revision", restored.sourceRevision);
  await expect(card).toBeVisible();
  await expect(interaction).not.toHaveAttribute("data-selected-at", /.+/);
  await interaction.focus();
  await expect(interaction).toHaveAttribute("data-selected-at", replacement.observedAt);
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

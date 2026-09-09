const configRoot = document.querySelector("[data-status-root]");
const REFRESH_INTERVAL_MS = Number(configRoot?.dataset.refreshIntervalMs) || 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const STALE_AFTER_MS = Number(configRoot?.dataset.staleAfterMs) || 120_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const states = new Set([
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "maintenance",
  "unknown",
]);
const stateRank = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
  unknown: 5,
};
const stateLabels = {
  operational: "Operational",
  degraded: "Outage",
  partial_outage: "Outage",
  major_outage: "Outage",
  maintenance: "Maintenance",
  unknown: "Status delayed",
};
const incidentStates = new Set(["investigating", "identified", "monitoring", "resolved"]);
const incidentImpacts = new Set(["none", "degraded", "partial_outage", "major_outage"]);
const maintenanceStates = new Set(["scheduled", "active", "verifying", "completed", "cancelled"]);
const statusCopy = {
  operational: {
    title: configRoot?.dataset.copyOperational || "All systems operational",
  },
  degraded: {
    title: configRoot?.dataset.copyDegraded || "Some systems are degraded",
    detail: "Some requests may be slower than usual.",
  },
  partial_outage: {
    title: configRoot?.dataset.copyPartialOutage || "Partial service outage",
    detail: "Some services are currently unavailable.",
  },
  major_outage: {
    title: configRoot?.dataset.copyMajorOutage || "Major service outage",
    detail: "We are investigating and will post updates below.",
  },
  maintenance: {
    title: configRoot?.dataset.copyMaintenance || "Maintenance in progress",
    detail: "Some systems may be temporarily affected.",
  },
  unknown: {
    title: configRoot?.dataset.copyUnknown || "Status data is delayed",
    detail: "Showing the most recent verified results below.",
  },
};
const siteLocale = document.documentElement.lang || "en";
const siteTimeZone = configRoot?.dataset.timeZone || "UTC";
const siteDateTime = new Intl.DateTimeFormat(siteLocale, {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: siteTimeZone,
  timeZoneName: "short",
});
const siteTime = new Intl.DateTimeFormat(siteLocale, {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: siteTimeZone,
  timeZoneName: "short",
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSlug(value) {
  return typeof value === "string" && /^[a-z0-9-]+$/.test(value);
}

function isUpdate(update, allowedStates) {
  return (
    isRecord(update) &&
    typeof update.id === "string" &&
    allowedStates.has(update.state) &&
    typeof update.message === "string" &&
    isTimestamp(update.publishedAt)
  );
}

function isIncident(incident) {
  return (
    isRecord(incident) &&
    isSlug(incident.slug) &&
    typeof incident.title === "string" &&
    incidentStates.has(incident.state) &&
    incidentImpacts.has(incident.impact) &&
    Array.isArray(incident.updates) &&
    incident.updates.length > 0 &&
    incident.updates.every((update) => isUpdate(update, incidentStates))
  );
}

function isMaintenance(maintenance) {
  return (
    isRecord(maintenance) &&
    isSlug(maintenance.slug) &&
    typeof maintenance.title === "string" &&
    maintenanceStates.has(maintenance.state) &&
    isTimestamp(maintenance.startsAt) &&
    isTimestamp(maintenance.endsAt) &&
    Date.parse(maintenance.startsAt) < Date.parse(maintenance.endsAt) &&
    Array.isArray(maintenance.updates) &&
    maintenance.updates.every((update) => isUpdate(update, maintenanceStates))
  );
}

function isLatencyPoint(point) {
  return (
    isRecord(point) &&
    isTimestamp(point.observedAt) &&
    isFiniteNonNegative(point.avgMs) &&
    isFiniteNonNegative(point.p95Ms)
  );
}

function isSnapshot(value) {
  if (!isRecord(value) || value.schemaVersion !== "1.0.0") return false;
  if (
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    !Number.isFinite(Date.parse(value.latestCheckAt))
  )
    return false;
  if (
    typeof value.sourceRevision !== "string" ||
    value.sourceRevision.length < 8 ||
    !states.has(value.overallStatus)
  )
    return false;
  if (
    !Array.isArray(value.components) ||
    !Array.isArray(value.activeIncidents) ||
    !Array.isArray(value.scheduledMaintenance)
  )
    return false;

  if (value.components.length === 0) return false;
  const slugs = new Set(value.components.map((component) => component?.slug));
  if (slugs.size !== value.components.length) return false;
  if (!value.activeIncidents.every(isIncident) || !value.scheduledMaintenance.every(isMaintenance))
    return false;

  return value.components.every(
    (component) =>
      isRecord(component) &&
      typeof component.slug === "string" &&
      /^[a-z0-9-]+$/.test(component.slug) &&
      typeof component.name === "string" &&
      states.has(component.state) &&
      (component.responseTimeMs === null || isFiniteNonNegative(component.responseTimeMs)) &&
      Array.isArray(component.history) &&
      component.history.length === 90 &&
      component.history.every(
        (day) =>
          isRecord(day) &&
          typeof day.date === "string" &&
          states.has(day.state) &&
          (day.uptime === null ||
            (typeof day.uptime === "number" && day.uptime >= 0 && day.uptime <= 100)),
      ) &&
      (component.latency === null ||
        (Array.isArray(component.latency) &&
          component.latency.length >= 12 &&
          component.latency.every(isLatencyPoint))),
  );
}

function canApplySnapshot(snapshot) {
  const renderedRows = [...document.querySelectorAll("[data-component-slug]")];
  if (renderedRows.length !== snapshot.components.length) return false;

  return snapshot.components.every((component) => {
    const row = document.querySelector(`[data-component-slug="${component.slug}"]`);
    if (row?.querySelectorAll(".uptime-day").length !== 90) return false;
    if (
      !row.querySelector("[data-component-state]") ||
      !row.querySelector("[data-component-response]")
    )
      return false;
    const latencyCard = document.querySelector(`[data-latency-slug="${component.slug}"]`);
    if (component.latency === null) return latencyCard === null;
    if (!latencyCard) return false;
    return [
      "[data-latency-checked]",
      "[data-latency-now]",
      "[data-latency-average]",
      "[data-latency-p95]",
      "[data-chart-average]",
      "[data-chart-p95]",
      "[data-chart-max]",
      "[data-chart-min]",
      "[data-chart-start]",
      "svg",
    ].every((selector) => latencyCard.querySelector(selector));
  });
}

function deriveState(snapshot, responseTime) {
  const generatedAt = Date.parse(snapshot.generatedAt);
  const latestCheckAt = Date.parse(snapshot.latestCheckAt);
  if (
    latestCheckAt > generatedAt ||
    generatedAt > responseTime + MAX_FUTURE_SKEW_MS ||
    latestCheckAt > responseTime + MAX_FUTURE_SKEW_MS ||
    responseTime - latestCheckAt > STALE_AFTER_MS
  )
    return "unknown";

  let result = "operational";
  for (const component of snapshot.components) {
    if (stateRank[component.state] > stateRank[result]) result = component.state;
  }
  for (const incident of snapshot.activeIncidents) {
    if (
      incident?.state !== "resolved" &&
      states.has(incident?.impact) &&
      stateRank[incident.impact] > stateRank[result]
    ) {
      result = incident.impact;
    }
  }
  return result;
}

function updateBanner(state, latestCheckAt) {
  const banner = document.querySelector("[data-state-banner]");
  const title = document.querySelector("[data-overall-title]");
  const detail = document.querySelector("[data-overall-detail]");
  const checkLabel = document.querySelector("[data-check-label]");
  const checked = document.querySelector("[data-latest-check]");
  if (!banner || !title || !detail || !checkLabel || !checked) return;

  for (const possibleState of states) banner.classList.remove(`state-${possibleState}`);
  banner.classList.add(`state-${state}`);
  title.textContent = statusCopy[state].title;
  detail.textContent = statusCopy[state].detail ?? "";
  detail.hidden = !statusCopy[state].detail;
  checkLabel.textContent = state === "unknown" ? "Last verified" : "Last checked";
  checked.dateTime = latestCheckAt;
  checked.textContent = siteDateTime.format(new Date(latestCheckAt));
  const summary = document.querySelector("[data-state-summary]");
  if (summary) {
    const operational = document.querySelectorAll("[data-component-state].text-operational").length;
    const total = document.querySelectorAll("[data-component-state]").length;
    summary.textContent = `${operational} of ${total} services operational`;
  }
}

function historySummary(component) {
  const measured = component.history.filter((day) => typeof day.uptime === "number");
  const interruptions = component.history.filter((day) => day.state !== "operational").length;
  const average = measured.length
    ? `${(measured.reduce((sum, day) => sum + day.uptime, 0) / measured.length).toFixed(3)}% average uptime.`
    : "No uptime measurement is available.";
  const interruptionCopy =
    interruptions === 0
      ? "No interrupted days."
      : `${interruptions} ${interruptions === 1 ? "day" : "days"} with an interruption.`;
  return `${component.name}, 90-day history. ${average} ${interruptionCopy}`;
}

function updateComponents(components) {
  for (const component of components) {
    const row = document.querySelector(`[data-component-slug="${component.slug}"]`);
    if (!row) continue;
    const state = row.querySelector("[data-component-state]");
    const response = row.querySelector("[data-component-response]");
    const history = row.querySelector("[data-component-history]");
    if (state) {
      for (const possibleState of states) state.classList.remove(`text-${possibleState}`);
      state.classList.add(`text-${component.state}`);
      state.textContent = stateLabels[component.state];
    }
    if (response)
      response.textContent =
        component.responseTimeMs === null
          ? "Response unavailable"
          : `${Math.round(component.responseTimeMs)} ms response`;
    if (!history) continue;
    history.setAttribute("aria-label", historySummary(component));
    const days = history.querySelectorAll(".uptime-day");
    component.history.forEach((day, index) => {
      const cell = days[index];
      if (!cell) return;
      for (const possibleState of states) cell.classList.remove(`day-${possibleState}`);
      cell.classList.add(`day-${day.state}`);
      cell.dateTime = day.date;
      cell.title =
        day.uptime === null ? `${day.date}: no uptime data` : `${day.date}: ${day.uptime}% uptime`;
    });
  }
}

function chartData(latency) {
  const values = latency.flatMap((point) => [point.avgMs, point.p95Ms]);
  const min = Math.floor(Math.min(...values) / 25) * 25;
  const max = Math.ceil(Math.max(...values) / 25) * 25;
  const span = Math.max(max - min, 25);
  const point = (value, index) => {
    const x = 18 + (index / (latency.length - 1)) * 564;
    const y = 142 - ((value - min) / span) * 118;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  return {
    min,
    max,
    average: Math.round(latency.reduce((sum, item) => sum + item.avgMs, 0) / latency.length),
    averages: latency.map((item, index) => point(item.avgMs, index)).join(" "),
    p95: latency.map((item, index) => point(item.p95Ms, index)).join(" "),
  };
}

function updateLatency(components) {
  for (const component of components) {
    if (!Array.isArray(component.latency) || component.latency.length < 2) continue;
    const card = document.querySelector(`[data-latency-slug="${component.slug}"]`);
    if (!card) continue;
    const latency = component.latency;
    const latest = latency.at(-1);
    const data = chartData(latency);
    card.querySelector("[data-latency-checked]").textContent =
      `Checked ${siteTime.format(new Date(latest.observedAt))}`;
    card.querySelector("[data-latency-now]").textContent = `${Math.round(latest.avgMs)} ms`;
    card.querySelector("[data-latency-average]").textContent = `${data.average} ms`;
    card.querySelector("[data-latency-p95]").textContent = `${Math.round(latest.p95Ms)} ms`;
    card.querySelector("[data-chart-average]").setAttribute("points", data.averages);
    card.querySelector("[data-chart-p95]").setAttribute("points", data.p95);
    card.querySelector("[data-chart-max]").textContent = `${data.max} ms`;
    card.querySelector("[data-chart-min]").textContent = `${data.min} ms`;
    card.querySelector("[data-chart-start]").textContent = siteTime.format(
      new Date(latency[0].observedAt),
    );
    const chart = card.querySelector("svg");
    chart.setAttribute(
      "aria-label",
      `${component.name} response time across recent published checks. Latest average ${Math.round(latest.avgMs)} milliseconds, average across the visible checks ${data.average} milliseconds, latest 95th percentile ${Math.round(latest.p95Ms)} milliseconds. Scale ${data.min} to ${data.max} milliseconds.`,
    );
  }
}

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function renderEvents(snapshot) {
  const container = document.querySelector("[data-live-events]");
  if (!container) return;
  const fragment = document.createDocumentFragment();
  const incident = snapshot.activeIncidents.find((item) => item.state !== "resolved");

  if (incident && typeof incident.slug === "string" && /^[a-z0-9-]+$/.test(incident.slug)) {
    const section = element("section", `active-incident incident-${incident.impact}`);
    section.setAttribute("aria-labelledby", "incident-title");
    const heading = element("div");
    heading.append(element("p", "eyebrow", "Active incident"));
    const title = element("h2", "", incident.title);
    title.id = "incident-title";
    heading.append(title);
    const update = element("div", "incident-update");
    update.append(
      element(
        "span",
        "state-label",
        incident.state === "monitoring" ? "Under observation" : stateLabels[incident.impact],
      ),
    );
    update.append(
      element("p", "", incident.updates?.at(-1)?.message ?? "An update is in progress."),
    );
    const link = element("a", "", "View incident details");
    link.href = `/incidents/${incident.slug}/`;
    update.append(link);
    section.append(heading, update);
    fragment.append(section);
  }

  const maintenance = snapshot.scheduledMaintenance.find((item) =>
    ["scheduled", "active", "verifying"].includes(item.state),
  );
  if (
    maintenance &&
    typeof maintenance.slug === "string" &&
    /^[a-z0-9-]+$/.test(maintenance.slug)
  ) {
    const aside = element("aside", "maintenance-callout");
    aside.setAttribute("aria-labelledby", "maintenance-title");
    const summary = element("div", "maintenance-summary");
    summary.append(
      element(
        "p",
        "eyebrow",
        maintenance.state === "scheduled" ? "Scheduled maintenance" : "Maintenance in progress",
      ),
    );
    const title = element("h2", "", maintenance.title);
    title.id = "maintenance-title";
    summary.append(title);
    const timing = element("p", "maintenance-time");
    timing.append(element("span", "", maintenance.state === "scheduled" ? "Starts" : "Started"));
    const time = element("time", "", siteDateTime.format(new Date(maintenance.startsAt)));
    time.dateTime = maintenance.startsAt;
    timing.append(time);
    const link = element("a", "", "View details");
    link.href = "/maintenance/";
    link.setAttribute("aria-label", `View ${maintenance.title} details`);
    aside.append(summary, timing, link);
    fragment.append(aside);
  }

  container.replaceChildren(fragment);
}

function applySnapshot(snapshot, responseTime) {
  const root = document.querySelector("[data-status-root]");
  if (!root || !canApplySnapshot(snapshot)) return false;
  const currentGeneratedAt = Date.parse(root.dataset.generatedAt ?? "");
  const nextGeneratedAt = Date.parse(snapshot.generatedAt);
  if (Number.isFinite(currentGeneratedAt) && nextGeneratedAt < currentGeneratedAt) return false;
  if (
    nextGeneratedAt === currentGeneratedAt &&
    root.dataset.sourceRevision === snapshot.sourceRevision
  ) {
    updateBanner(deriveState(snapshot, responseTime), snapshot.latestCheckAt);
    root.dataset.lastRefreshAt = new Date(responseTime).toISOString();
    return true;
  }
  updateComponents(snapshot.components);
  updateLatency(snapshot.components);
  renderEvents(snapshot);
  updateBanner(deriveState(snapshot, responseTime), snapshot.latestCheckAt);
  root.dataset.sourceRevision = snapshot.sourceRevision;
  root.dataset.generatedAt = snapshot.generatedAt;
  root.dataset.lastRefreshAt = new Date(responseTime).toISOString();
  return true;
}

function applyStaleIfNeeded(now = Date.now()) {
  const checked = document.querySelector("[data-latest-check]");
  if (checked?.dateTime && now - Date.parse(checked.dateTime) > STALE_AFTER_MS) {
    updateBanner("unknown", checked.dateTime);
  }
}

let refreshPromise;

async function runRefresh() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("/current.json", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Status snapshot request failed");
    const snapshot = await response.json();
    if (!isSnapshot(snapshot)) throw new Error("Status snapshot validation failed");
    const responseDate = Date.parse(response.headers.get("Date") ?? "");
    const responseAge = Number(response.headers.get("Age") ?? 0);
    const responseTime = Number.isFinite(responseDate)
      ? responseDate + (Number.isFinite(responseAge) ? responseAge * 1000 : 0)
      : Date.now();
    applySnapshot(snapshot, responseTime);
  } catch {
    applyStaleIfNeeded();
  } finally {
    clearTimeout(timeout);
  }
}

function refresh() {
  if (!refreshPromise) {
    refreshPromise = runRefresh().finally(() => {
      refreshPromise = undefined;
    });
  }
  return refreshPromise;
}

let timer;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await refresh();
    schedule();
  }, REFRESH_INTERVAL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refresh();
    schedule();
  }
});

refresh();
schedule();

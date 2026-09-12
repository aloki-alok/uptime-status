const recordRoot = document.querySelector(
  "[data-history-list], [data-maintenance-list], [data-incident-detail]",
);
const locale = document.documentElement.lang || "en";
const timeZone = recordRoot?.dataset.timeZone || "UTC";
const dateTime = new Intl.DateTimeFormat(locale, {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone,
  timeZoneName: "short",
});
const day = new Intl.DateTimeFormat(locale, {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone,
});

function node(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = String(text);
  return value;
}

function validIncident(value) {
  return (
    value &&
    typeof value === "object" &&
    /^[a-z0-9-]+$/.test(value.slug) &&
    typeof value.title === "string" &&
    Array.isArray(value.affectedComponents) &&
    Array.isArray(value.updates) &&
    value.updates.length > 0 &&
    value.updates.every(
      (update) =>
        typeof update.message === "string" && Number.isFinite(Date.parse(update.publishedAt)),
    )
  );
}

function validMaintenance(value) {
  return (
    value &&
    typeof value === "object" &&
    /^[a-z0-9-]+$/.test(value.slug) &&
    typeof value.title === "string" &&
    typeof value.expectedImpact === "string" &&
    Array.isArray(value.affectedComponents) &&
    Number.isFinite(Date.parse(value.startsAt)) &&
    Number.isFinite(Date.parse(value.endsAt))
  );
}

function timeElement(iso, formatter = dateTime) {
  const value = node("time", "", formatter.format(new Date(iso)));
  value.dateTime = iso;
  return value;
}

function line(label, content) {
  const wrapper = node("div");
  wrapper.append(node("dt", "", label));
  const description = node("dd");
  description.append(content instanceof Node ? content : document.createTextNode(String(content)));
  wrapper.append(description);
  return wrapper;
}

function namesFor(slugs, names) {
  return slugs.map((slug) => names.get(slug) || slug).join(", ");
}

function incidentsFrom(snapshot) {
  return [
    ...snapshot.activeIncidents,
    ...snapshot.recentEvents.filter((event) => "startedAt" in event),
  ]
    .filter(validIncident)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

function renderHistory(snapshot) {
  const container = document.querySelector("[data-history-list]");
  if (!container) return;
  const names = new Map(snapshot.components.map((component) => [component.slug, component.name]));
  const incidents = incidentsFrom(snapshot);
  if (!incidents.length) {
    container.replaceChildren(node("p", "empty-state", "No incidents have been published."));
    return;
  }
  const cards = incidents.map((incident) => {
    const article = node(
      "article",
      `event-record${incident.state === "resolved" ? " muted-record" : ""}`,
    );
    const date = node("div", "event-date");
    date.append(timeElement(incident.startedAt, day));
    const content = node("div");
    content.append(
      node(
        "span",
        `state-label${incident.state === "resolved" ? "" : ` text-${incident.impact}`}`,
        incident.state.replaceAll("_", " "),
      ),
    );
    const heading = node("h2");
    const link = node("a", "", incident.title);
    link.href = `/incidents/?id=${incident.slug}`;
    heading.append(link);
    content.append(heading, node("p", "", incident.updates.at(-1)?.message || ""));
    const meta = node("dl", "event-meta");
    const end = incident.resolvedAt
      ? Date.parse(incident.resolvedAt)
      : Date.parse(snapshot.generatedAt);
    const minutes = Math.max(1, Math.round((end - Date.parse(incident.startedAt)) / 60_000));
    meta.append(
      line("Impact", incident.impact.replaceAll("_", " ")),
      line("Affected", namesFor(incident.affectedComponents, names)),
      line("Duration", `${minutes} minutes`),
    );
    content.append(meta);
    article.append(date, content);
    return article;
  });
  container.replaceChildren(...cards);
}

function renderMaintenance(snapshot) {
  const container = document.querySelector("[data-maintenance-list]");
  if (!container) return;
  const names = new Map(snapshot.components.map((component) => [component.slug, component.name]));
  const windows = snapshot.scheduledMaintenance.filter(validMaintenance);
  if (!windows.length) {
    container.replaceChildren(node("p", "empty-state", "No maintenance is currently planned."));
    return;
  }
  const cards = windows.map((maintenance) => {
    const section = node("section", "maintenance-record");
    const status = node("div", "maintenance-status");
    status.append(node("span", "state-label text-maintenance", maintenance.state));
    const minutes = Math.max(
      1,
      Math.round((Date.parse(maintenance.endsAt) - Date.parse(maintenance.startsAt)) / 60_000),
    );
    status.append(node("span", "", `${minutes} minutes`));
    const body = node("div");
    body.append(node("h2", "", maintenance.title), node("p", "", maintenance.expectedImpact));
    const grid = node("dl", "maintenance-grid");
    grid.append(
      line("Start in your timezone", timeElement(maintenance.startsAt)),
      line("End in your timezone", timeElement(maintenance.endsAt)),
      line("Scheduled in", maintenance.sourceTimeZone),
      line("Affected components", namesFor(maintenance.affectedComponents, names)),
    );
    body.append(grid);
    section.append(status, body);
    return section;
  });
  container.replaceChildren(...cards);
}

function renderDetail(snapshot) {
  const container = document.querySelector("[data-incident-detail]");
  if (!container) return;
  const slug = new URLSearchParams(location.search).get("id");
  const incident = incidentsFrom(snapshot).find((item) => item.slug === slug);
  if (!incident) {
    container.replaceChildren(
      node("h1", "", "Incident not found"),
      node("p", "empty-state", "Incident not found in the published record."),
    );
    return;
  }
  const names = new Map(snapshot.components.map((component) => [component.slug, component.name]));
  const breadcrumb = node("nav", "breadcrumb");
  breadcrumb.setAttribute("aria-label", "Breadcrumb");
  const back = node("a", "", "Past incidents");
  back.href = "/history/";
  breadcrumb.append(back, node("span", "", " / "), node("span", "", "Incident"));
  const heading = node("header", "incident-heading");
  const headingText = node("div");
  headingText.append(
    node("p", "eyebrow", incident.state === "resolved" ? "Past incident" : "Active incident"),
    node("h1", "", incident.title),
  );
  heading.append(
    headingText,
    node("span", `incident-state text-${incident.impact}`, incident.state.replaceAll("_", " ")),
  );
  const summary = node("section", "incident-summary");
  const summaryList = node("dl");
  summaryList.append(
    line("Started", timeElement(incident.startedAt)),
    line("Impact", incident.impact.replaceAll("_", " ")),
    line("Affected", namesFor(incident.affectedComponents, names)),
  );
  if (incident.resolvedAt) summaryList.append(line("Resolved", timeElement(incident.resolvedAt)));
  summary.append(summaryList);
  const timeline = node("section", "incident-timeline");
  const timelineHeader = node("header");
  timelineHeader.append(node("p", "eyebrow", "Response log"), node("h2", "", "Incident updates"));
  const updates = node("ol");
  for (const update of [...incident.updates].reverse()) {
    const item = node("li");
    item.append(node("div", "timeline-marker"));
    const article = node("article");
    const meta = node("div", "timeline-meta");
    meta.append(node("h3", "", update.state.replaceAll("_", " ")), timeElement(update.publishedAt));
    article.append(meta, node("p", "", update.message));
    item.append(article);
    updates.append(item);
  }
  timeline.append(timelineHeader, updates);
  container.replaceChildren(breadcrumb, heading, summary, timeline);
  document.title = `${incident.title} | Status`;
}

async function refreshRecords() {
  if (!recordRoot) return;
  try {
    const response = await fetch("/current.json", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("Snapshot unavailable");
    const snapshot = await response.json();
    if (
      snapshot?.schemaVersion !== "1.0.0" ||
      !Array.isArray(snapshot.components) ||
      !Array.isArray(snapshot.activeIncidents) ||
      !Array.isArray(snapshot.scheduledMaintenance) ||
      !Array.isArray(snapshot.recentEvents)
    )
      throw new Error("Invalid snapshot");
    renderHistory(snapshot);
    renderMaintenance(snapshot);
    renderDetail(snapshot);
  } catch {
    const loading = document.querySelector("[data-incident-loading]");
    if (loading)
      loading.textContent =
        "Incident details are temporarily unavailable. Please try again shortly.";
  }
}

refreshRecords();
setInterval(refreshRecords, 60_000);

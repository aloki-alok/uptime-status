const uptimeTooltip = document.querySelector("#uptime-day-tooltip");
const uptimeStateLabels = {
  operational: "Operational",
  degraded: "Outage",
  partial_outage: "Outage",
  major_outage: "Outage",
  maintenance: "Maintenance",
  unknown: "Status delayed",
};
const uptimeDate = new Intl.DateTimeFormat(document.documentElement.lang || "en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
let activeUptimeDay;

function uptimeDayDetail(day) {
  const date = uptimeDate.format(new Date(`${day.date}T00:00:00Z`));
  const state = uptimeStateLabels[day.state] ?? "Status delayed";
  const uptime = day.uptime === null ? "No uptime data." : `${day.uptime}% uptime.`;
  const down = `${day.downMinutes} ${day.downMinutes === 1 ? "minute" : "minutes"} down.`;
  return `${date}. ${state}. ${uptime} ${down}`;
}

function updateUptimeDay(cell, day) {
  const detail = uptimeDayDetail(day);
  cell.dateTime = day.date;
  cell.dataset.uptimeDetail = detail;
  cell.setAttribute("aria-label", detail);
  if (cell === activeUptimeDay) showUptimeTooltip(cell);
}

function showUptimeTooltip(cell) {
  if (!uptimeTooltip || !cell.dataset.uptimeDetail) return;
  activeUptimeDay?.removeAttribute("aria-describedby");
  activeUptimeDay = cell;
  cell.setAttribute("aria-describedby", uptimeTooltip.id);
  uptimeTooltip.textContent = cell.dataset.uptimeDetail;
  uptimeTooltip.hidden = false;
  const rect = cell.getBoundingClientRect();
  const tooltipRect = uptimeTooltip.getBoundingClientRect();
  const left = Math.min(
    window.innerWidth - tooltipRect.width / 2 - 8,
    Math.max(tooltipRect.width / 2 + 8, rect.left + rect.width / 2),
  );
  const above = rect.top - tooltipRect.height - 10;
  uptimeTooltip.style.left = `${left}px`;
  uptimeTooltip.style.top = `${above >= 8 ? above : rect.bottom + 10}px`;
}

function hideUptimeTooltip(cell) {
  if (!uptimeTooltip || activeUptimeDay !== cell || cell.matches(":focus")) return;
  cell.removeAttribute("aria-describedby");
  activeUptimeDay = undefined;
  uptimeTooltip.hidden = true;
}

for (const history of document.querySelectorAll("[data-component-history]")) {
  const days = [...history.querySelectorAll(".uptime-day")];
  for (const [index, day] of days.entries()) {
    day.addEventListener("pointerenter", () => showUptimeTooltip(day));
    day.addEventListener("pointerleave", () => hideUptimeTooltip(day));
    day.addEventListener("focus", () => showUptimeTooltip(day));
    day.addEventListener("blur", () => hideUptimeTooltip(day));
    day.addEventListener("keydown", (event) => {
      let nextIndex;
      if (event.key === "ArrowLeft") nextIndex = Math.max(0, index - 1);
      if (event.key === "ArrowRight") nextIndex = Math.min(days.length - 1, index + 1);
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = days.length - 1;
      if (event.key === "Escape") {
        day.removeAttribute("aria-describedby");
        activeUptimeDay = undefined;
        if (uptimeTooltip) uptimeTooltip.hidden = true;
        return;
      }
      if (nextIndex === undefined) return;
      event.preventDefault();
      for (const candidate of days) candidate.tabIndex = -1;
      days[nextIndex].tabIndex = 0;
      days[nextIndex].focus();
    });
  }
}

window.uptimeHistory = { updateDay: updateUptimeDay };

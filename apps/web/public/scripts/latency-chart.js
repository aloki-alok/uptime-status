(() => {
  const VIEWBOX_WIDTH = 600;
  const VIEWBOX_HEIGHT = 160;
  const locale = document.documentElement.lang || "en";
  const root = document.querySelector("[data-status-root]");
  const timeZone = root?.dataset.timeZone || "UTC";
  const time = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });

  function parsePoints(interaction) {
    try {
      const value = JSON.parse(interaction.dataset.chartPoints || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function controller(card) {
    const interaction = card.querySelector("[data-latency-interaction]");
    const tooltip = card.querySelector("[data-latency-tooltip]");
    const tooltipTime = card.querySelector("[data-latency-tooltip-time]");
    const tooltipValue = card.querySelector("[data-latency-tooltip-value]");
    const tooltipSamples = card.querySelector("[data-latency-tooltip-samples]");
    const announcement = card.querySelector("[data-latency-announcement]");
    const cursor = card.querySelector("[data-chart-cursor]");
    const cursorPoint = card.querySelector("[data-chart-cursor-point]");
    if (
      !interaction ||
      !tooltip ||
      !tooltipTime ||
      !tooltipValue ||
      !tooltipSamples ||
      !announcement ||
      !cursor ||
      !cursorPoint
    ) {
      return null;
    }

    let points = parsePoints(interaction);
    let selectedIndex = -1;
    let inputMode = "none";
    let cachedBounds;
    let pendingPoint;
    let positionFrame;

    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            cachedBounds = undefined;
            if (selectedIndex >= 0) positionTooltip(points[selectedIndex]);
          })
        : null;
    resizeObserver?.observe(interaction);

    function hide() {
      selectedIndex = -1;
      delete interaction.dataset.selectedAt;
      tooltip.hidden = true;
      cursor.setAttribute("visibility", "hidden");
      cursorPoint.setAttribute("visibility", "hidden");
    }

    function positionTooltip(point) {
      pendingPoint = point;
      if (positionFrame) return;
      positionFrame = requestAnimationFrame(() => {
        positionFrame = undefined;
        const current = pendingPoint;
        if (!current || tooltip.hidden) return;
        const bounds = cachedBounds ?? interaction.getBoundingClientRect();
        cachedBounds = bounds;
        const x = (current.x / VIEWBOX_WIDTH) * bounds.width;
        const y = (current.y / VIEWBOX_HEIGHT) * bounds.height;
        const width = tooltip.offsetWidth;
        const height = tooltip.offsetHeight;
        const left = Math.max(6, Math.min(bounds.width - width - 6, x - width / 2));
        const preferredTop = y - height - 10;
        const top = preferredTop >= 6 ? preferredTop : Math.min(bounds.height - height - 6, y + 10);
        tooltip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
      });
    }

    function show(index, announce = false) {
      const point = points[index];
      if (!point) return;
      selectedIndex = index;
      interaction.dataset.selectedAt = point.observedAt;
      tooltipTime.dateTime = point.observedAt;
      tooltipTime.textContent = time.format(new Date(point.observedAt));
      tooltipValue.textContent = `${number.format(point.avgMs)} ms`;
      tooltipSamples.textContent = `${number.format(point.sampleCount)} ${point.sampleCount === 1 ? "check" : "checks"}`;
      if (announce) {
        announcement.textContent = `${tooltipTime.textContent}, ${tooltipValue.textContent}, ${tooltipSamples.textContent}`;
      }
      cursor.setAttribute("x1", String(point.x));
      cursor.setAttribute("x2", String(point.x));
      cursorPoint.setAttribute("cx", String(point.x));
      cursorPoint.setAttribute("cy", String(point.y));
      tooltip.hidden = false;
      cursor.removeAttribute("visibility");
      cursorPoint.removeAttribute("visibility");
      positionTooltip(point);
    }

    function nearest(clientX) {
      const bounds = cachedBounds ?? interaction.getBoundingClientRect();
      cachedBounds = bounds;
      const x = ((clientX - bounds.left) / bounds.width) * VIEWBOX_WIDTH;
      return points.reduce(
        (closest, point, index) =>
          Math.abs(point.x - x) < closest.distance
            ? { distance: Math.abs(point.x - x), index }
            : closest,
        { distance: Number.POSITIVE_INFINITY, index: 0 },
      ).index;
    }

    interaction.addEventListener("pointermove", (event) => {
      if (points.length === 0) return;
      inputMode = event.pointerType === "touch" ? "touch" : "pointer";
      show(nearest(event.clientX));
    });
    interaction.addEventListener("pointerdown", (event) => {
      if (points.length === 0) return;
      inputMode = event.pointerType === "touch" ? "touch" : "pointer";
      show(nearest(event.clientX));
    });
    interaction.addEventListener("pointerleave", () => {
      if (inputMode === "pointer") hide();
    });
    interaction.addEventListener("focus", () => {
      if (selectedIndex < 0 && points.length > 0) {
        inputMode = "keyboard";
        show(points.length - 1, true);
      }
    });
    interaction.addEventListener("blur", hide);
    interaction.addEventListener("pointercancel", hide);
    interaction.addEventListener("keydown", (event) => {
      if (points.length === 0) return;
      let next = selectedIndex < 0 ? points.length - 1 : selectedIndex;
      if (event.key === "ArrowLeft") next = Math.max(0, next - 1);
      else if (event.key === "ArrowRight") next = Math.min(points.length - 1, next + 1);
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = points.length - 1;
      else if (event.key === "Escape") {
        hide();
        return;
      } else return;
      event.preventDefault();
      inputMode = "keyboard";
      show(next, true);
    });

    return {
      hide,
      update(nextPoints) {
        const selectedAt = points[selectedIndex]?.observedAt;
        points = nextPoints;
        interaction.dataset.chartPoints = JSON.stringify(points);
        const nextIndex = selectedAt
          ? points.findIndex((point) => point.observedAt === selectedAt)
          : -1;
        if (nextIndex >= 0) show(nextIndex);
        else if (document.activeElement === interaction && points.length > 0)
          show(points.length - 1, true);
        else hide();
      },
    };
  }

  const controllers = new WeakMap();
  for (const card of document.querySelectorAll("[data-latency-slug]")) {
    const instance = controller(card);
    if (instance) controllers.set(card, instance);
  }

  document.addEventListener("pointerdown", (event) => {
    for (const card of document.querySelectorAll("[data-latency-slug]")) {
      if (!card.contains(event.target)) controllers.get(card)?.hide();
    }
  });

  window.latencyCharts = {
    update(card, points) {
      controllers.get(card)?.update(points);
    },
  };
})();

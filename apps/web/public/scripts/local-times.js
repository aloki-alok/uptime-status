const formatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

for (const element of document.querySelectorAll("[data-local-time]")) {
  const value = element.getAttribute("datetime");
  if (value) element.textContent = formatter.format(new Date(value));
}

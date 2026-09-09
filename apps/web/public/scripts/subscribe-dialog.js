const dialog = document.querySelector("[data-subscribe-dialog]");
const triggers = document.querySelectorAll("[data-dialog-open]");
const form = document.querySelector('[data-subscribe-form="enabled"]');
const feedback = form?.querySelector("[data-subscribe-status]");
let opener = null;

for (const trigger of triggers) {
  trigger.addEventListener("click", () => {
    opener = trigger;
    dialog?.showModal();
  });
}

dialog?.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

dialog?.addEventListener("close", () => {
  opener?.focus();
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = form.elements.namedItem("email");
  const button = form.querySelector('button[type="submit"]');
  if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) return;
  if (!input.reportValidity()) return;

  button.disabled = true;
  button.textContent = "Sending...";
  if (feedback) feedback.textContent = "";
  try {
    const response = await fetch("/api/v1/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: input.value }),
    });
    if (response.status !== 202) throw new Error("subscription-request-failed");
    input.value = "";
    if (feedback) feedback.textContent = "Check your inbox to confirm your subscription.";
  } catch {
    if (feedback) feedback.textContent = "We could not save that request. Try again in a moment.";
  } finally {
    button.disabled = false;
    button.textContent = "Subscribe";
  }
});

import { createInterface } from "node:readline/promises";
import {
  type Incident,
  type Maintenance,
  type SiteConfig,
  siteConfigIssues,
} from "@uptime-status/domain";
import { MonitorStore } from "@uptime-status/monitor";
import { type CuratedEvent, type CuratedKind, CuratedStore } from "./curated";

const HELP = `Usage: status <kind> <action> [slug]

  status incident list
  status incident open
  status incident update <slug>
  status incident resolve <slug>
  status maintenance list
  status maintenance schedule
  status maintenance update <slug>
  status maintenance cancel <slug>
  status maintenance complete <slug>

Commands with changes ask short questions, show a preview, then require PUBLISH.
Only people with server access can run this command. No text file is needed.`;

type Questions = ReturnType<typeof createInterface>;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function timestampAfter(previous: string | undefined) {
  return new Date(Math.max(Date.now(), Date.parse(previous ?? "") + 1 || 0)).toISOString();
}

function slugFor(title: string, store: CuratedStore, kind: CuratedKind) {
  const stem =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 70)
      .replace(/-$/, "") || kind;
  const date = new Date().toISOString().slice(0, 10);
  const base = `${stem}-${date}`;
  let slug = base;
  let suffix = 2;
  while (store.get(kind, slug)) slug = `${base}-${suffix++}`;
  return slug;
}

async function required(questions: Questions, label: string, current?: string) {
  for (;;) {
    const answer = (await questions.question(`${label}${current ? ` [${current}]` : ""}: `)).trim();
    if (answer) return answer;
    if (current) return current;
    console.log("Please enter a value.");
  }
}

async function select(questions: Questions, label: string, choices: string[], current?: string) {
  console.log(`${label}:`);
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}. ${choice.replaceAll("_", " ")}`);
  });
  for (;;) {
    const answer = (
      await questions.question(`Number${current ? ` [${choices.indexOf(current) + 1}]` : ""}: `)
    ).trim();
    if (!answer && current) return current;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index];
    console.log("Choose one of the listed numbers.");
  }
}

async function components(questions: Questions, site: SiteConfig, current?: string[]) {
  console.log("Affected services:");
  site.components.forEach((component, index) => {
    console.log(`  ${index + 1}. ${component.name}`);
  });
  for (;;) {
    const defaultNumbers = current
      ?.map((slug) => site.components.findIndex((item) => item.componentId === slug) + 1)
      .join(",");
    const answer =
      (
        await questions.question(
          `Numbers, separated by commas${defaultNumbers ? ` [${defaultNumbers}]` : ""}: `,
        )
      ).trim() || defaultNumbers;
    const numbers = answer?.split(",").map((part) => Number(part.trim())) ?? [];
    if (
      numbers.length > 0 &&
      numbers.every(
        (number) => Number.isInteger(number) && number >= 1 && number <= site.components.length,
      ) &&
      new Set(numbers).size === numbers.length
    ) {
      return numbers.map((number) => site.components[number - 1].componentId);
    }
    console.log("Enter one or more unique service numbers, such as 1,3.");
  }
}

function parseTime(input: string) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\s*(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!match) return null;
  const value = new Date(`${match[1]}T${match[2]}:00${match[3]}`);
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

async function time(questions: Questions, label: string, current?: string) {
  const example = "2026-09-12 16:00 +05:30";
  for (;;) {
    const answer = (
      await questions.question(
        `${label} (for example ${example})${current ? ` [${current}]` : ""}: `,
      )
    ).trim();
    if (!answer && current) return current;
    const parsed = parseTime(answer);
    if (parsed) return parsed;
    console.log("Include the date, time, and UTC offset, such as +05:30.");
  }
}

function preview(kind: CuratedKind, event: CuratedEvent, site: SiteConfig) {
  const names = new Map(site.components.map((item) => [item.componentId, item.name]));
  console.log("\nPUBLIC NOTICE PREVIEW");
  console.log("=".repeat(48));
  console.log(event.title);
  console.log(`Services: ${event.affectedComponents.map((slug) => names.get(slug)).join(", ")}`);
  if (kind === "incident") {
    const incident = event as Incident;
    console.log(`Status: ${incident.state.replaceAll("_", " ")}`);
    console.log(`Impact: ${incident.impact.replaceAll("_", " ")}`);
    console.log(`Started: ${incident.startedAt}`);
  } else {
    const maintenance = event as Maintenance;
    console.log(`Status: ${maintenance.state}`);
    console.log(`Start: ${maintenance.startsAt}`);
    console.log(`End: ${maintenance.endsAt}`);
    console.log(`Expected impact: ${maintenance.expectedImpact}`);
  }
  console.log(`Update: ${event.updates.at(-1)?.message}`);
  console.log("=".repeat(48));
}

async function createIncident(
  questions: Questions,
  store: CuratedStore,
  site: SiteConfig,
): Promise<Incident> {
  const title = await required(questions, "Incident title");
  const affectedComponents = await components(questions, site);
  const impact = (await select(questions, "Impact", [
    "degraded",
    "partial_outage",
    "major_outage",
  ])) as Incident["impact"];
  const message = await required(questions, "Customer update (plain text)");
  const now = timestampAfter(undefined);
  return {
    slug: slugFor(title, store, "incident"),
    revision: 1,
    title,
    state: "investigating",
    impact,
    affectedComponents,
    startedAt: now,
    updates: [{ id: crypto.randomUUID(), state: "investigating", message, publishedAt: now }],
  };
}

async function changeIncident(
  questions: Questions,
  current: Incident,
  site: SiteConfig,
  action: string,
): Promise<Incident> {
  const state =
    action === "resolve"
      ? "resolved"
      : ((await select(
          questions,
          "Status",
          ["investigating", "identified", "monitoring"],
          current.state,
        )) as Incident["state"]);
  const impact =
    action === "resolve"
      ? current.impact
      : ((await select(
          questions,
          "Impact",
          ["degraded", "partial_outage", "major_outage"],
          current.impact,
        )) as Incident["impact"]);
  const affectedComponents =
    action === "resolve"
      ? current.affectedComponents
      : await components(questions, site, current.affectedComponents);
  const message = await required(
    questions,
    action === "resolve" ? "Resolution message" : "Customer update (plain text)",
  );
  const publishedAt = timestampAfter(current.updates.at(-1)?.publishedAt);
  return {
    ...current,
    revision: current.revision + 1,
    state,
    impact,
    affectedComponents,
    ...(state === "resolved" ? { resolvedAt: publishedAt } : {}),
    updates: [...current.updates, { id: crypto.randomUUID(), state, message, publishedAt }],
  };
}

async function createMaintenance(
  questions: Questions,
  store: CuratedStore,
  site: SiteConfig,
): Promise<Maintenance> {
  const title = await required(questions, "Maintenance title");
  const affectedComponents = await components(questions, site);
  let startsAt: string;
  let endsAt: string;
  for (;;) {
    startsAt = await time(questions, "Start time");
    endsAt = await time(questions, "End time");
    if (Date.parse(endsAt) > Date.parse(startsAt)) break;
    console.log("End time must be after start time.");
  }
  const expectedImpact = await required(questions, "Expected customer impact");
  const message = await required(questions, "Customer update (plain text)");
  const publishedAt = timestampAfter(undefined);
  return {
    slug: slugFor(title, store, "maintenance"),
    revision: 1,
    title,
    state: "scheduled",
    expectedImpact,
    affectedComponents,
    startsAt,
    endsAt,
    sourceTimeZone: site.timeZone,
    updates: [{ id: crypto.randomUUID(), state: "scheduled", message, publishedAt }],
  };
}

async function changeMaintenance(
  questions: Questions,
  current: Maintenance,
  site: SiteConfig,
  action: string,
): Promise<Maintenance> {
  const state =
    action === "cancel" ? "cancelled" : action === "complete" ? "completed" : current.state;
  let startsAt = current.startsAt;
  let endsAt = current.endsAt;
  let expectedImpact = current.expectedImpact;
  let affectedComponents = current.affectedComponents;
  if (action === "update") {
    startsAt = await time(questions, "Start time", current.startsAt);
    endsAt = await time(questions, "End time", current.endsAt);
    if (Date.parse(endsAt) <= Date.parse(startsAt))
      throw new Error("End time must be after start time");
    expectedImpact = await required(questions, "Expected customer impact", current.expectedImpact);
    affectedComponents = await components(questions, site, current.affectedComponents);
  }
  const message = await required(
    questions,
    action === "cancel"
      ? "Cancellation message"
      : action === "complete"
        ? "Completion message"
        : "Customer update (plain text)",
  );
  const publishedAt = timestampAfter(current.updates.at(-1)?.publishedAt);
  return {
    ...current,
    revision: current.revision + 1,
    state,
    startsAt,
    endsAt,
    expectedImpact,
    affectedComponents,
    updates: [...current.updates, { id: crypto.randomUUID(), state, message, publishedAt }],
  };
}

export async function runOperator(args: string[]) {
  if (args.length === 0 || args.includes("--help") || args[0] === "help") {
    console.log(HELP);
    return 0;
  }
  const [kind, action, slug] = args;
  if (kind !== "incident" && kind !== "maintenance") throw new Error(HELP);
  const sitePath = process.env.STATUS_SITE_CONFIG;
  const databasePath = process.env.STATUS_DATABASE;
  if (!sitePath || !databasePath)
    throw new Error("STATUS_SITE_CONFIG and STATUS_DATABASE are required");
  const parsed: unknown = JSON.parse(await Bun.file(sitePath).text());
  const issues = siteConfigIssues(parsed);
  if (issues.length)
    throw new Error(`Site configuration is invalid: ${issues[0].path}: ${issues[0].message}`);
  const site = parsed as SiteConfig;
  const monitor = new MonitorStore(databasePath);
  try {
    const store = new CuratedStore(monitor.db, site);
    if (action === "list" && !slug) {
      const events = kind === "incident" ? store.all().incidents : store.all().maintenances;
      if (!events.length) console.log(`No ${kind}s published.`);
      for (const event of events) console.log(`${event.slug}\t${event.state}\t${event.title}`);
      return 0;
    }
    const allowed =
      kind === "incident"
        ? ["open", "update", "resolve"]
        : ["schedule", "update", "cancel", "complete"];
    if (!allowed.includes(action) || (action === "open" || action === "schedule" ? !!slug : !slug))
      throw new Error(HELP);
    if (!process.stdin.isTTY)
      throw new Error(
        "Publishing requires an interactive terminal. Run with ssh -t and docker exec -it.",
      );
    const current = slug ? store.get(kind, slug) : null;
    if (slug && !current) throw new Error(`No ${kind} named ${slug}`);
    if (kind === "incident" && current && (current as Incident).state === "resolved")
      throw new Error("This incident is already resolved");
    if (
      kind === "maintenance" &&
      current &&
      ["cancelled", "completed"].includes((current as Maintenance).state)
    )
      throw new Error("This maintenance is already closed");
    const questions = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const next =
        kind === "incident"
          ? current
            ? await changeIncident(questions, current as Incident, site, action)
            : await createIncident(questions, store, site)
          : current
            ? await changeMaintenance(questions, current as Maintenance, site, action)
            : await createMaintenance(questions, store, site);
      preview(kind, next, site);
      const confirmation = (
        await questions.question("Type PUBLISH to make this public, or press Enter to cancel: ")
      ).trim();
      if (confirmation !== "PUBLISH") {
        console.log("Cancelled. Nothing was changed.");
        return 0;
      }
      store.save(
        kind,
        next,
        current?.revision ?? null,
        process.env.STATUS_ACTOR || "server-operator",
        action,
      );
      console.log(`Saved ${kind} ${next.slug}. The monitor will publish it within 60 seconds.`);
      return 0;
    } finally {
      questions.close();
    }
  } finally {
    monitor.db.close();
  }
}

if (import.meta.main) {
  runOperator(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(errorMessage(error));
      process.exit(1);
    },
  );
}

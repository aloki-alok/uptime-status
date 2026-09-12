import type { SiteConfig } from "@uptime-status/domain";

/** Minimal valid SiteConfig with one https source bound to one component. */
export function testSite(): SiteConfig {
  return {
    schemaVersion: "1.0.0",
    deploymentMode: "example",
    siteId: "example-site",
    displayName: "Example Site",
    legalName: "Example Site",
    locale: "en",
    timeZone: "UTC",
    domains: { primary: "status.example.com" },
    brand: {
      homeUrl: "https://example.com",
      logoLightPath: "./assets/logo-light.svg",
      logoDarkPath: "./assets/logo-dark.svg",
      iconLightPath: "./assets/icon-light.svg",
      iconDarkPath: "./assets/icon-dark.svg",
      faviconPath: "./assets/favicon.svg",
      logoAlt: "Example Site",
    },
    presentation: {
      statusCopy: {
        operational: "All systems operational",
        degraded: "Some systems are degraded",
        partialOutage: "Some services are unavailable",
        majorOutage: "Major service outage",
        maintenance: "Maintenance in progress",
        unknown: "Status data is delayed",
      },
      semanticColors: {
        operational: "#16805c",
        maintenance: "#2f6feb",
        degraded: "#a56712",
        outage: "#b7433c",
        unknown: "#65716e",
      },
    },
    monitoring: {
      pollIntervalSeconds: 60,
      staleAfterSeconds: 120,
      sources: [{ sourceId: "web", adapter: "https", url: "https://example.com/health" }],
    },
    components: [
      {
        componentId: "public-api",
        name: "Public API",
        group: "Core",
        sourceId: "web",
        monitorRef: "monitor-1",
        showLatency: false,
      },
    ],
    subscriptions: {
      enabled: false,
      disabledReason: "delivery-not-configured",
      doubleOptIn: true,
    },
  };
}

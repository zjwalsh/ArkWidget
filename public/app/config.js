export function getWidgetConfig() {
  const config = window.__ARK_WIDGET_CONFIG__ ?? {};

  return {
    widgetName: config.widgetName ?? "ark-widget",
    widgetProvider: config.widgetProvider ?? "ArkWidget",
    basePath: config.basePath ?? "/",
    sdkScriptPath: config.sdkScriptPath ?? "./vendor/@wxcc-desktop/sdk/dist/index.js",
    ariesForwardPath: config.ariesForwardPath ?? "/api/third-party/forward",
    ariesNewCallEndpoint: config.ariesNewCallEndpoint ??  "/contact-arrivals",
    commandStreamPath: config.commandStreamPath ?? "/events",
    desktopRegistrationPath: config.desktopRegistrationPath ?? "/api/desktop-client",
    requireAgentDesktop: config.requireAgentDesktop ?? true
  };
}
